import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/composition/index.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
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
import { expectAuthProblem, loadUserApi, type OpenApiDoc } from "../helpers/openapi.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";

describe.skipIf(!migratorOk)("auth failure-mode parity (STH-46)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
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
  }, 120_000);

  afterAll(async () => {
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function buildConfiguredApp(pool: Pool | null): Promise<FastifyInstance> {
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
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      AUTO_LINK_BY_EMAIL: "false",
    };
    const config = loadConfig(env);
    const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);
    return buildApp(config, {
      pool,
      auth: {
        config: config.oidc,
        jwtVerifier,
        skipDiscovery: false,
      },
    });
  }

  async function completeLogin(app: FastifyInstance): Promise<{
    sessionCookie: string;
    csrfCookie: string;
  }> {
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    expect(login.statusCode).toBe(302);
    const idpRes = await fetch(login.headers.location!, { redirect: "manual" });
    const callbackLocation = idpRes.headers.get("location")!;
    const callbackPath = callbackLocation.replace("http://127.0.0.1:8080", "");
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      cookies: { sms_oauth: oauthCookie },
    });
    expect(callback.statusCode).toBe(302);
    return {
      sessionCookie: cookieValue(callback, "sms_session")!,
      csrfCookie: cookieValue(callback, "sms_csrf")!,
    };
  }

  it("DB errors while resolving a session become 500 internal_error (retryable)", async () => {
    const app = await buildConfiguredApp(appPool);
    await app.ready();
    const { sessionCookie } = await completeLogin(app);

    const exploding = {
      query: async () => {
        throw new Error("simulated postgres outage");
      },
      connect: async () => {
        throw new Error("simulated postgres outage");
      },
      end: async () => undefined,
    } as unknown as Pool;

    const broken = await buildConfiguredApp(exploding);
    await broken.ready();
    const res = await broken.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: sessionCookie },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal_error", retryable: true });
    await broken.close();
    await app.close();
  });

  it("OIDC unconfigured returns 401 on /v1/auth/me (not 503)", async () => {
    const env = {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
      DATABASE_URL: appDatabaseUrl(),
    };
    const config = loadConfig(env);
    expect(config.oidc).toBeNull();
    const app = await buildApp(config, { pool: appPool });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expectAuthProblem(userApi, "/v1/auth/me", "get", res, 401);
    const bearer = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(bearer.statusCode).toBe(401);
    await app.close();
  });

  it("OIDC configured without a pool still redirects on /v1/auth/login", async () => {
    const app = await buildConfiguredApp(null);
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    expect(login.statusCode).toBe(302);
    expect(String(login.headers.location)).toContain(mock.issuer);
    await app.close();
  });

  it("DB errors while resolving a bearer become 500 internal_error (retryable)", async () => {
    const app = await buildConfiguredApp(appPool);
    await app.ready();
    const exploding = {
      query: async () => {
        throw new Error("simulated postgres outage");
      },
      connect: async () => {
        throw new Error("simulated postgres outage");
      },
      end: async () => undefined,
    } as unknown as Pool;

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
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      AUTO_LINK_BY_EMAIL: "false",
    };
    const config = loadConfig(env);
    const broken = await buildApp(config, {
      pool: exploding,
      auth: {
        config: config.oidc,
        jwtVerifier: {
          async verify() {
            return {
              payload: { sub: "sub-alice", amr: ["pwd", "otp"] },
              sub: "sub-alice",
              iss: mock.issuer,
            };
          },
        },
        oidcProvider: {
          async startAuthorization() {
            return { redirectUrl: "https://example/authorize", sealedState: "s" };
          },
          async finishAuthorization() {
            throw new Error("unused");
          },
        },
        skipDiscovery: true,
      },
    });
    await broken.ready();
    const res = await broken.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal_error", retryable: true });
    await broken.close();
    await app.close();
  });

  it("device auth DB failure becomes 500, never device_unknown 401", async () => {
    const exploding = {
      query: async () => {
        throw new Error("simulated postgres outage");
      },
      connect: async () => {
        throw new Error("simulated postgres outage");
      },
      end: async () => undefined,
    } as unknown as Pool;

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
      PUBLIC_BASE_URL: "http://10.0.2.2:8080/",
      DEVICE_API_PUBLIC_URL: "http://10.0.2.2:8080",
      DEVICE_ALLOWED_HOSTS: "10.0.2.2:8080,api.sms-gateway.example,127.0.0.1:8080",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      AUTO_LINK_BY_EMAIL: "false",
    };
    const config = loadConfig(env);
    const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);
    const broken = await buildApp(config, {
      pool: exploding,
      auth: { config: config.oidc, jwtVerifier, skipDiscovery: false },
    });
    const { signDeviceRequest } = await import("../helpers/device-signing.js");
    await broken.ready();

    const deviceId = "00000000-0000-4000-8000-000000000099";
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: "10.0.2.2:8080",
      deviceId,
      body: "{}",
    });
    const res = await broken.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: signed.body,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal_error", retryable: true });
    expect(res.json().code).not.toBe("device_unknown");
    await broken.close();
  });

  it("pairing-codes DB failure becomes 500, never 401/403/404", async () => {
    const exploding = {
      query: async () => {
        throw new Error("simulated postgres outage");
      },
      connect: async () => {
        throw new Error("simulated postgres outage");
      },
      end: async () => undefined,
    } as unknown as Pool;

    const app = await buildConfiguredApp(exploding);
    await app.ready();
    // Login needs a working pool — use real pool for session, then swap for issue.
    // Instead: authenticate against real app, then hit broken app with forged session is hard.
    // Direct path: build with real pool, complete login, then rebuild inject path via use-case
    // fault by using exploding pool for the pairing-code insert only.
    await app.close();

    const healthy = await buildConfiguredApp(appPool);
    await healthy.ready();
    const { sessionCookie, csrfCookie } = await completeLogin(healthy);
    await healthy.close();

    const broken = await buildConfiguredApp(exploding);
    await broken.ready();
    const res = await broken.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      cookies: { sms_session: sessionCookie, sms_csrf: csrfCookie },
      headers: {
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie,
      },
    });
    // Session lookup itself fails on exploding pool → 500 (not unauthorized).
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal_error", retryable: true });
    expect([401, 403, 404]).not.toContain(res.statusCode);
    await broken.close();
  });

  it("CSRF-rejected requests do not update last_seen_at (awaits fire-and-forget)", async () => {
    const { createHash } = await import("node:crypto");
    const app = await buildConfiguredApp(appPool);
    await app.ready();
    const { sessionCookie, csrfCookie } = await completeLogin(app);
    const sessionHash = createHash("sha256").update(sessionCookie).digest("hex");

    // Seed a stable old timestamp so an early touch is observable after a wait.
    const seeded = new Date("2020-01-01T00:00:00.000Z");
    await admin.query(`UPDATE sessions SET last_seen_at = $1 WHERE session_id_hash = $2`, [
      seeded,
      sessionHash,
    ]);

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      cookies: { sms_session: sessionCookie, sms_csrf: csrfCookie },
      headers: {
        origin: "https://evil.example",
        "x-csrf-token": csrfCookie,
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "csrf_rejected" });

    // Wait long enough that a fire-and-forget early touch would have committed.
    await new Promise((r) => setTimeout(r, 350));
    const afterReject = await admin.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM sessions WHERE session_id_hash = $1`,
      [sessionHash],
    );
    expect(afterReject.rows[0]!.last_seen_at.getTime()).toBe(seeded.getTime());

    // Positive control: a successful authenticated request DOES advance last_seen_at.
    const ok = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: sessionCookie },
    });
    expect(ok.statusCode).toBe(200);
    const advanced = await pollLastSeen(
      admin,
      sessionHash,
      (t) => t.getTime() > seeded.getTime(),
      2000,
    );
    expect(advanced.getTime()).toBeGreaterThan(seeded.getTime());
    await app.close();
  });

  it("STH-48: JWKS HTTP 500/503/non-JSON → 500 retryable; bad token still 401", async () => {
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
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      AUTO_LINK_BY_EMAIL: "false",
    };
    const config = loadConfig(env);

    // Provision identity so a good token would resolve after JWKS recovers.
    const provision = await buildConfiguredApp(appPool);
    await provision.ready();
    await completeLogin(provision);
    await provision.close();

    const faults: Array<{ status: number; body: string; contentType?: string }> = [
      { status: 500, body: JSON.stringify({ error: "down" }) },
      { status: 503, body: JSON.stringify({ error: "unavailable" }) },
      { status: 200, body: "<html>not-json</html>", contentType: "text/html" },
    ];

    for (const fault of faults) {
      mock.setJwksFault(fault);
      const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);
      const app = await buildApp(config, {
        pool: appPool,
        auth: { config: config.oidc, jwtVerifier, skipDiscovery: false },
      });
      await app.ready();
      const token = await mock.signToken({
        sub: "sub-alice",
        email: "alice@example.com",
        amr: ["pwd", "otp"],
      });
      const res = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `JWKS fault ${fault.status}`).toBe(500);
      expect(res.json()).toMatchObject({ code: "internal_error", retryable: true });
      await app.close();
    }

    mock.setJwksFault(null);
    const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);
    const app = await buildApp(config, {
      pool: appPool,
      auth: { config: config.oidc, jwtVerifier, skipDiscovery: false },
    });
    await app.ready();
    const bad = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: "unauthorized" });
    await app.close();
  });

  it("STH-50: kid-less token vs multi-key JWKS → 401 (not 500); unknown kid → 401", async () => {
    // Provision identity first (single-key JWKS).
    const provision = await buildConfiguredApp(appPool);
    await provision.ready();
    await completeLogin(provision);
    await provision.close();

    mock.setMultiKeyJwks(true);
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
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      AUTO_LINK_BY_EMAIL: "false",
    };
    const config = loadConfig(env);
    // Fresh verifier so JWKS is fetched with 3 keys (no single-key cache).
    const jwtVerifier = createJwtVerifier(config.oidc!, mock.jwksUri);
    const app = await buildApp(config, {
      pool: appPool,
      auth: { config: config.oidc, jwtVerifier, skipDiscovery: false },
    });
    await app.ready();

    const kidLess = await mock.signToken(
      { sub: "sub-alice", email: "alice@example.com", amr: ["pwd", "otp"] },
      { omitKid: true },
    );
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${kidLess}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "unauthorized" });
    expect(res.json().code).not.toBe("internal_error");

    const unknownKid = await mock.signToken(
      { sub: "sub-alice", email: "alice@example.com", amr: ["pwd", "otp"] },
      { kid: "no-such-kid" },
    );
    // Sign with our private key but advertise a kid not in JWKS → JWKSNoMatchingKey → 401.
    // (Signature won't verify against a missing key; jose raises before verify.)
    const noMatch = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${unknownKid}` },
    });
    expect(noMatch.statusCode).toBe(401);
    expect(noMatch.json()).toMatchObject({ code: "unauthorized" });

    mock.setMultiKeyJwks(false);
    await app.close();
  });

  it("STH-48: IdP /token HTTP 503 → 500; invalid_grant still 400", async () => {
    const app = await buildConfiguredApp(appPool);
    await app.ready();

    mock.setTokenFault({ status: 503, body: JSON.stringify({ error: "temporarily_unavailable" }) });
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    expect(login.statusCode).toBe(302);
    const idpRes = await fetch(login.headers.location!, { redirect: "manual" });
    const callbackPath = idpRes.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const down = await app.inject({
      method: "GET",
      url: callbackPath,
      cookies: { sms_oauth: oauthCookie },
    });
    expect(down.statusCode).toBe(500);
    expect(down.json()).toMatchObject({ code: "internal_error", retryable: true });

    mock.setTokenFault({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    const login2 = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const idpRes2 = await fetch(login2.headers.location!, { redirect: "manual" });
    const callbackPath2 = idpRes2.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const oauthCookie2 = cookieValue(login2, "sms_oauth")!;
    const badGrant = await app.inject({
      method: "GET",
      url: callbackPath2,
      cookies: { sms_oauth: oauthCookie2 },
    });
    expect(badGrant.statusCode).toBe(400);
    expect(badGrant.json()).toMatchObject({ code: "invalid_request" });

    mock.setTokenFault({
      status: 200,
      body: "<html>nope</html>",
      contentType: "text/html",
    });
    const login3 = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const idpRes3 = await fetch(login3.headers.location!, { redirect: "manual" });
    const callbackPath3 = idpRes3.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const oauthCookie3 = cookieValue(login3, "sms_oauth")!;
    const nonJson = await app.inject({
      method: "GET",
      url: callbackPath3,
      cookies: { sms_oauth: oauthCookie3 },
    });
    expect(nonJson.statusCode).toBe(500);
    expect(nonJson.json()).toMatchObject({ code: "internal_error", retryable: true });

    mock.setTokenFault(null);
    await app.close();
  });
});

async function pollLastSeen(
  admin: Pool,
  sessionHash: string,
  pred: (t: Date) => boolean,
  timeoutMs: number,
): Promise<Date> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await admin.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM sessions WHERE session_id_hash = $1`,
      [sessionHash],
    );
    const t = rows[0]?.last_seen_at;
    if (t && pred(t)) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("last_seen_at did not advance in time");
}

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
