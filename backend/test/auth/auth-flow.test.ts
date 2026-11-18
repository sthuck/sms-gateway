import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { requireUserAuth } from "../../src/adapters/http-fastify/auth-plugin.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import { findOrProvisionUser } from "../../src/adapters/db-postgres/provision.js";
import { mapClaims } from "../../src/domain/auth/claims.js";
import {
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";
import { startMockOidc, type MockOidc } from "../helpers/mock-oidc.js";
import { expectAuthProblem, expectMe, loadUserApi, type OpenApiDoc } from "../helpers/openapi.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";

describe.skipIf(!migratorOk)("OIDC auth flow (mock provider)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let messageB: string;
  let userApi: OpenApiDoc;

  beforeAll(async () => {
    userApi = await loadUserApi();
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();

    mock = await startMockOidc({
      clientId: "sms-gateway-test",
      clientSecret: "dev-only-test-client-secret",
      redirectUri: "http://127.0.0.1:8080/v1/auth/callback",
      defaultClaims: {
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice",
        amr: ["pwd", "otp"],
      },
    });

    const env = {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
      DATABASE_URL: appDatabaseUrl(),
      OIDC_ISSUER_URL: mock.issuer,
      OIDC_CLIENT_ID: "sms-gateway-test",
      OIDC_CLIENT_SECRET: "dev-only-test-client-secret",
      OIDC_REDIRECT_URI: "http://127.0.0.1:8080/v1/auth/callback",
      OIDC_AUDIENCE: "sms-gateway-test",
      SESSION_SECRET,
      REQUIRE_MFA: "true",
      MFA_CLAIMS_MISSING: "deny",
      OIDC_ALLOW_INSECURE: "true",
      PUBLIC_BASE_URL: "http://127.0.0.1:8080/",
      AUTO_LINK_BY_EMAIL: "false",
    };

    const config = loadConfig(env);
    const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);

    app = await buildApp(config, {
      pool: appPool,
      auth: {
        config: config.oidc,
        jwtVerifier,
        skipDiscovery: false,
      },
    });

    app.get("/v1/test/messages", { preHandler: requireUserAuth }, async (request) => {
      const ids = await request.withOwner(async (client) => {
        const { rows } = await client.query<{ id: string }>(`SELECT id FROM messages`);
        return rows.map((r) => r.id);
      });
      return { owner_id: request.ownerId, message_ids: ids };
    });

    await app.ready();

    const userB = (
      await admin.query<{ id: string }>(
        `INSERT INTO users (email, mfa_enrolled) VALUES ('bob@example.com', true) RETURNING id`,
      )
    ).rows[0]!.id;
    await admin.query(`UPDATE users SET owner_id = id WHERE id = $1`, [userB]);
    const deviceB = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, status) VALUES ($1, 'Bob Phone', 'active') RETURNING id`,
        [userB],
      )
    ).rows[0]!.id;
    messageB = (
      await admin.query<{ id: string }>(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext, received_at, direction
         ) VALUES ($1, $2, 'bob-1', '+1', decode('bb', 'hex'), now(), 'inbound')
         RETURNING id`,
        [userB, deviceB],
      )
    ).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function completeLogin(claimOverride?: Record<string, unknown>): Promise<{
    sessionCookie: string;
    csrfCookie: string;
    statusCode: number;
    body?: unknown;
  }> {
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    expect(login.statusCode).toBe(302);
    const idpLocation = login.headers.location;
    expect(idpLocation).toBeTruthy();
    const oauthCookie = cookieValue(login, "sms_oauth");
    expect(oauthCookie).toBeTruthy();

    const idpRes = await fetch(idpLocation!, { redirect: "manual" });
    expect(idpRes.status).toBe(302);
    const callbackLocation = idpRes.headers.get("location");
    expect(callbackLocation).toBeTruthy();

    if (claimOverride) {
      const code = new URL(callbackLocation!).searchParams.get("code");
      expect(code).toBeTruthy();
      mock.setCodeClaims(code!, claimOverride);
    }

    const callbackPath = callbackLocation!.replace("http://127.0.0.1:8080", "");
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      cookies: { sms_oauth: oauthCookie! },
    });

    if (callback.statusCode !== 302) {
      return {
        sessionCookie: "",
        csrfCookie: "",
        statusCode: callback.statusCode,
        body: safeJson(callback),
      };
    }

    return {
      sessionCookie: cookieValue(callback, "sms_session")!,
      csrfCookie: cookieValue(callback, "sms_csrf")!,
      statusCode: callback.statusCode,
    };
  }

  it("first login provisions a user via (issuer, sub)", async () => {
    const { sessionCookie } = await completeLogin();
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: sessionCookie },
    });
    const body = expectMe(userApi, me) as { id: string; email: string; mfa_enrolled: boolean };
    expect(body.email).toBe("alice@example.com");
    expect(body.mfa_enrolled).toBe(true);

    const { rows } = await admin.query<{ issuer: string; sub: string; owner_id: string }>(
      `SELECT issuer, sub, owner_id FROM user_identities WHERE sub = 'sub-alice'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issuer).toBe(mock.issuer);
    expect(rows[0]!.owner_id).toBe(body.id);
  });

  it("second login reuses the same user", async () => {
    const first = await completeLogin();
    const me1 = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: first.sessionCookie },
    });
    const id1 = (me1.json() as { id: string }).id;

    const second = await completeLogin();
    const me2 = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: second.sessionCookie },
    });
    expect((me2.json() as { id: string }).id).toBe(id1);

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email = 'alice@example.com'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("logout clears cookies (204)", async () => {
    const { sessionCookie, csrfCookie } = await completeLogin();
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      cookies: { sms_session: sessionCookie, sms_csrf: csrfCookie },
    });
    expect(logout.statusCode).toBe(204);
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: sessionCookie },
    });
    expectAuthProblem(userApi, "/v1/auth/me", "get", me, 401);
  });

  it("rejects bad state", async () => {
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const idpLocation = login.headers.location!;
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const idpRes = await fetch(idpLocation, { redirect: "manual" });
    const callbackLocation = idpRes.headers.get("location")!;
    const cb = new URL(callbackLocation);
    cb.searchParams.set("state", "tampered-state");

    const callback = await app.inject({
      method: "GET",
      url: cb.pathname + cb.search,
      cookies: { sms_oauth: oauthCookie },
    });
    expectAuthProblem(userApi, "/v1/auth/callback", "get", callback, 400);
  });

  it("rejects MFA-required login when amr/acr absent", async () => {
    const result = await completeLogin({
      sub: "sub-nofa",
      email: "nofa@example.com",
      name: "No MFA",
      amr: null,
      acr: null,
    });
    expect(result.statusCode).toBe(401);
    const body = result.body as { code: string };
    expect(body.code).toBe("mfa_required");
  });

  it("returns 401 for missing, expired, and wrong-aud bearer JWTs", async () => {
    // Provision alice identity so a valid token would resolve.
    await findOrProvisionUser(
      appPool,
      mock.issuer,
      mapClaims({
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice",
        amr: ["pwd", "otp"],
      }),
      { mfaEnrolled: true, lastAuthMethod: "otp", autoLinkByEmail: false },
    );

    const missing = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expectAuthProblem(userApi, "/v1/auth/me", "get", missing, 401);

    const expired = await mock.signToken(
      { sub: "sub-alice", email: "alice@example.com", amr: ["pwd", "otp"] },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    const expiredRes = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(expiredRes.statusCode).toBe(401);

    const wrongAud = await mock.signToken(
      { sub: "sub-alice", email: "alice@example.com", amr: ["pwd", "otp"] },
      { aud: "someone-else" },
    );
    const wrongAudRes = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${wrongAud}` },
    });
    expect(wrongAudRes.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("rejects bearer JWT without email claim when MFA claims are absent (STH-36)", async () => {
    await findOrProvisionUser(
      appPool,
      mock.issuer,
      mapClaims({
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice",
        amr: ["pwd", "otp"],
      }),
      { mfaEnrolled: true, lastAuthMethod: "otp", autoLinkByEmail: false },
    );

    // No email, no amr/acr — previously skipped MFA when mapClaims failed.
    const token = await mock.signToken({ sub: "sub-alice", amr: ["pwd"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "mfa_required" });
  });

  it("accepts bearer JWT without email claim when MFA claims are present (STH-36)", async () => {
    await findOrProvisionUser(
      appPool,
      mock.issuer,
      mapClaims({
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice",
        amr: ["pwd", "otp"],
      }),
      { mfaEnrolled: true, lastAuthMethod: "otp", autoLinkByEmail: false },
    );

    const token = await mock.signToken({ sub: "sub-alice", amr: ["pwd", "otp"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { email: string }).email).toBe("alice@example.com");
  });

  it("authenticated handlers see app.owner_id and cannot see other owners' rows", async () => {
    const { sessionCookie } = await completeLogin();
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: sessionCookie },
    });
    const aliceId = (me.json() as { id: string }).id;

    const listed = await app.inject({
      method: "GET",
      url: "/v1/test/messages",
      cookies: { sms_session: sessionCookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { owner_id: string; message_ids: string[] };
    expect(body.owner_id).toBe(aliceId);
    expect(body.message_ids).not.toContain(messageB);

    const bearer = await mock.signToken({
      sub: "sub-alice",
      email: "alice@example.com",
      amr: ["pwd", "otp"],
    });
    const viaBearer = await app.inject({
      method: "GET",
      url: "/v1/test/messages",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(viaBearer.statusCode).toBe(200);
    const bearerBody = viaBearer.json() as { owner_id: string; message_ids: string[] };
    expect(bearerBody.owner_id).toBe(aliceId);
    expect(bearerBody.message_ids).not.toContain(messageB);
  });
});

function cookieValue(
  response: {
    headers: Record<string, unknown>;
    cookies?: Array<{ name: string; value: string }>;
  },
  name: string,
): string | undefined {
  if (response.cookies) {
    const found = response.cookies.find((c) => c.name === name);
    if (found) return found.value;
  }
  const setCookie = response.headers["set-cookie"];
  const parts = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
  for (const part of parts) {
    const m = String(part).match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

function safeJson(response: { json: () => unknown }): unknown {
  try {
    return response.json();
  } catch {
    return null;
  }
}
