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
    const { deviceAuthPreHandler } = await import("../../src/device/plugin.js");
    const { signDeviceRequest } = await import("../helpers/device-signing.js");
    broken.post(
      "/v1/messages:batch",
      { preHandler: deviceAuthPreHandler({ rejectRevoked: true }) },
      async () => ({ ok: true }),
    );
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

  it("CSRF-rejected requests do not update last_seen_at", async () => {
    const app = await buildConfiguredApp(appPool);
    await app.ready();
    const { sessionCookie, csrfCookie } = await completeLogin(app);

    const before = await admin.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM sessions WHERE revoked_at IS NULL`,
    );
    const previous = before.rows[0]?.last_seen_at?.getTime() ?? null;

    // Give the clock a tick so a wrong touch would move last_seen_at.
    await new Promise((r) => setTimeout(r, 20));

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

    const after = await admin.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM sessions WHERE revoked_at IS NULL`,
    );
    const next = after.rows[0]?.last_seen_at?.getTime() ?? null;
    expect(next).toBe(previous);
    await app.close();
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
