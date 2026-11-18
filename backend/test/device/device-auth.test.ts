import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import { requireUserAuth } from "../../src/adapters/http-fastify/auth-plugin.js";
import { deviceAuthPreHandler } from "../../src/device/plugin.js";
import { hashPairingCode, normalizePairingCode } from "../../src/device/pairing-code.js";
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
import { freshNonce, signDeviceRequest, testVector } from "../helpers/device-signing.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";
const HOST = "10.0.2.2:8080";

describe.skipIf(!migratorOk)("pairing + device auth (STH-14)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let sessionCookie: string;
  let csrfCookie: string;
  let ownerId: string;

  beforeAll(async () => {
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
      PUBLIC_BASE_URL: "http://10.0.2.2:8080/",
      DEVICE_API_PUBLIC_URL: "http://10.0.2.2:8080",
      DEVICE_ALLOWED_HOSTS: "10.0.2.2:8080,api.sms-gateway.example,127.0.0.1:8080",
      PAIR_RATE_LIMIT_PER_IP: "100",
      PAIR_IP_INVALID_LOCK_THRESHOLD: "50",
      PAIR_IP_INVALID_LOCK_SEC: "60",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
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

    // Stand-in for STH-15 ingestion: auth only, then 200.
    app.post(
      "/v1/messages:batch",
      { preHandler: deviceAuthPreHandler({ rejectRevoked: true }) },
      async (request) => {
        return {
          results: [
            {
              device_msg_id: "probe",
              status: "accepted",
              id: "00000000-0000-4000-8000-000000000001",
            },
          ],
          device_id: request.device?.deviceId,
        };
      },
    );

    app.get("/v1/test/user-only", { preHandler: requireUserAuth }, async (request) => {
      return { owner_id: request.ownerId };
    });

    await app.ready();

    const login = await completeLogin();
    sessionCookie = login.sessionCookie;
    csrfCookie = login.csrfCookie;

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `${sessionCookie}; ${csrfCookie}` },
    });
    expect(me.statusCode).toBe(200);
    ownerId = (me.json() as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function completeLogin(): Promise<{
    sessionCookie: string;
    csrfCookie: string;
  }> {
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    expect(login.statusCode).toBe(302);
    const idpLocation = login.headers.location!;
    const oauthCookie = cookieValue(login, "sms_oauth")!;

    const idpRes = await fetch(idpLocation, { redirect: "manual" });
    const callbackLocation = idpRes.headers.get("location")!;
    const callbackPath = callbackLocation.replace("http://127.0.0.1:8080", "");
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: `sms_oauth=${oauthCookie}` },
    });
    expect(callback.statusCode).toBe(302);
    return {
      sessionCookie: `sms_session=${cookieValue(callback, "sms_session")}`,
      csrfCookie: `sms_csrf=${cookieValue(callback, "sms_csrf")}`,
    };
  }

  function userHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: "http://127.0.0.1:8080",
      "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      ...extra,
    };
  }

  async function issueCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: userHeaders(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      code: string;
      qr_payload: string;
      ttl_seconds: number;
    };
    expect(body.code).toMatch(/^[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}$/);
    expect(body.qr_payload.startsWith("smsgw://pair?")).toBe(true);
    expect(body.qr_payload).toContain("code=");
    expect(body.qr_payload).toContain("server=");
    expect(body.ttl_seconds).toBe(300);
    return body.code;
  }

  async function pairWithCode(code: string): Promise<{ device_id: string }> {
    const pairBody = {
      pairing_code: code,
      alg: "ES256" as const,
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: {
        name: "Google Pixel 8",
        platform: "android" as const,
        manufacturer: "Google",
        model: "Pixel 8",
        os_version: "14",
        app_version: "1.0.0",
        sdk_int: 34,
      },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { device_id: string };
  }

  it("rejects reused pairing codes", async () => {
    const code = await issueCode();
    await pairWithCode(code);

    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: {
        platform: "android",
        app_version: "1.0.0",
      },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_pairing_code", retryable: false });
  });

  it("rejects expired pairing codes", async () => {
    const code = "ABCD-EFGH";
    const normalized = normalizePairingCode(code)!;
    const codeHash = hashPairingCode(normalized);
    await admin.query(
      `INSERT INTO pairing_codes (owner_id, code_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 minute')`,
      [ownerId, codeHash],
    );

    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0" },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_pairing_code" });
  });

  it("rate-limits brute-force pair attempts per IP", async () => {
    const attackerIp = "203.0.113.50";
    // Pre-fill the shared Postgres bucket to the configured limit (100).
    await appPool.query(
      `INSERT INTO app.rate_limit_buckets (bucket_key, window_start, hit_count)
       VALUES ($1, now(), 100)
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_start = EXCLUDED.window_start, hit_count = EXCLUDED.hit_count`,
      [`pair:ip:${attackerIp}`],
    );

    const pairBody = {
      pairing_code: "ZZZZ-ZZZZ",
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0" },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    // Use remoteAddress (not a client-spoofable X-Forwarded-For).
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
      remoteAddress: attackerIp,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "rate_limited", retryable: true });
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("concurrent identical signed requests: exactly one succeeds (atomic replay)", async () => {
    const code = await issueCode();
    const { device_id } = await pairWithCode(code);
    const body = testVector.request.body;
    const nonce = freshNonce();
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId: device_id,
      body,
      nonce,
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/messages:batch",
          headers: signed.headers,
          payload: body,
        }),
      ),
    );
    const wins = results.filter((r) => r.statusCode === 200);
    const replays = results.filter((r) => r.statusCode === 401);
    expect(wins).toHaveLength(1);
    expect(replays.length).toBe(7);
    for (const r of replays) {
      expect(r.json()).toMatchObject({ code: "replay_detected", retryable: true });
    }
  });

  it("accepts a valid signature (shared test vector key) on ingestion path", async () => {
    const code = await issueCode();
    const { device_id } = await pairWithCode(code);

    // Override credential public key is already the test vector key from pair.
    const body = testVector.request.body;
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId: device_id,
      body,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ device_id });
  });

  it("verifies the frozen test-vector signature over the canonical string", async () => {
    const { verifyEs256P1363, parsePublicKeySpkiB64url } =
      await import("../../src/device/signing.js");
    const key = parsePublicKeySpkiB64url(testVector.testPublicKeySpkiB64url)!;
    expect(
      verifyEs256P1363(testVector.canonicalString, testVector.frozenSignatureB64url, key),
    ).toBe(true);
  });

  it("rejects tampered body, stale timestamp, replayed nonce, wrong key, unknown device", async () => {
    const code = await issueCode();
    const { device_id } = await pairWithCode(code);
    const body = testVector.request.body;

    // Tampered body
    {
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/messages:batch",
        host: HOST,
        deviceId: device_id,
        body,
      });
      const tampered = body.replace("123456", "999999");
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: tampered,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "content_hash_mismatch" });
    }

    // Stale timestamp
    {
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/messages:batch",
        host: HOST,
        deviceId: device_id,
        body,
        timestamp: Math.floor(Date.now() / 1000) - 10_000,
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        code: "invalid_timestamp",
        retryable: true,
      });
      expect(res.json()).toHaveProperty("server_time");
      expect(res.headers.date).toBeTruthy();
    }

    // Replay nonce
    {
      const nonce = freshNonce();
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/messages:batch",
        host: HOST,
        deviceId: device_id,
        body,
        nonce,
      });
      const first = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: body,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: body,
      });
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ code: "replay_detected", retryable: true });
    }

    // Wrong key
    {
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/messages:batch",
        host: HOST,
        deviceId: device_id,
        body,
        privateKeyPem: pem,
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "invalid_signature" });
    }

    // Unknown device
    {
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/messages:batch",
        host: HOST,
        deviceId: "018f3c2a-9b4d-7e21-a456-426614174099",
        body,
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages:batch",
        headers: signed.headers,
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "device_unknown", retryable: false });
    }
  });

  it("revoked device is rejected on the next write request (no status cache)", async () => {
    const code = await issueCode();
    const { device_id } = await pairWithCode(code);

    const revoke = await app.inject({
      method: "POST",
      url: `/v1/devices/${device_id}/revoke`,
      headers: userHeaders(),
    });
    expect(revoke.statusCode).toBe(204);

    const signedBody = testVector.request.body;
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId: device_id,
      body: signedBody,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: signedBody,
    });
    // Contract: 403 device_revoked on write routes (Linear AC said 401; contract wins).
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "device_revoked", retryable: false });

    // /me still works with status revoked
    const meSigned = signDeviceRequest({
      method: "GET",
      path: "/v1/devices/me",
      host: HOST,
      deviceId: device_id,
      body: "",
    });
    delete meSigned.headers["content-type"];
    const me = await app.inject({
      method: "GET",
      url: "/v1/devices/me",
      headers: meSigned.headers,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ status: "revoked", device_id });
  });

  it("other owners' devices 404 on revoke", async () => {
    const other = (
      await admin.query<{ id: string }>(
        `INSERT INTO users (email, mfa_enrolled) VALUES ('other@example.com', true) RETURNING id`,
      )
    ).rows[0]!.id;
    await admin.query(`UPDATE users SET owner_id = id WHERE id = $1`, [other]);
    const foreignDevice = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, status) VALUES ($1, 'Foreign', 'active') RETURNING id`,
        [other],
      )
    ).rows[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/devices/${foreignDevice}/revoke`,
      headers: userHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });

  it("device credentials cannot read user endpoints; user session cannot call device-only", async () => {
    const code = await issueCode();
    const { device_id } = await pairWithCode(code);

    const signed = signDeviceRequest({
      method: "GET",
      path: "/v1/auth/me",
      host: HOST,
      deviceId: device_id,
      body: "",
    });
    delete signed.headers["content-type"];
    const asDevice = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: signed.headers,
    });
    expect(asDevice.statusCode).toBe(401);
    expect(asDevice.json()).toMatchObject({ code: "unauthorized" });

    const userOnly = await app.inject({
      method: "GET",
      url: "/v1/test/user-only",
      headers: signed.headers,
    });
    expect(userOnly.statusCode).toBe(401);

    const sessionOnDevice = await app.inject({
      method: "GET",
      url: "/v1/devices/me",
      headers: userHeaders({ host: HOST }),
    });
    expect(sessionOnDevice.statusCode).toBeGreaterThanOrEqual(400);
    expect(["invalid_request", "unauthorized", "device_unknown"]).toContain(
      (sessionOnDevice.json() as { code: string }).code,
    );
  });

  it("stores only a hash of the pairing code", async () => {
    const code = await issueCode();
    const normalized = normalizePairingCode(code)!;
    const expectedHash = hashPairingCode(normalized);
    const { rows } = await admin.query<{ code_hash: string }>(
      `SELECT code_hash FROM pairing_codes WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ownerId],
    );
    expect(rows[0]?.code_hash).toBe(expectedHash);
    expect(rows[0]?.code_hash).not.toContain(code);
  });

  it("race: concurrent pair with same code — exactly one wins", async () => {
    const code = await issueCode();
    const make = () => {
      const pairBody = {
        pairing_code: code,
        alg: "ES256",
        public_key: testVector.testPublicKeySpkiB64url,
        device_info: { platform: "android", app_version: "1.0.0", name: "Race" },
      };
      const raw = JSON.stringify(pairBody);
      // Distinct nonces so replay cache does not interfere before burn.
      const signed = signDeviceRequest({
        method: "POST",
        path: "/v1/devices/pair",
        host: HOST,
        deviceId: "",
        body: raw,
      });
      return app.inject({
        method: "POST",
        url: "/v1/devices/pair",
        headers: signed.headers,
        payload: raw,
      });
    };

    const results = await Promise.all([make(), make(), make()]);
    const wins = results.filter((r) => r.statusCode === 201);
    const losses = results.filter((r) => r.statusCode === 400);
    expect(wins).toHaveLength(1);
    expect(losses.length).toBeGreaterThanOrEqual(1);
    for (const loss of losses) {
      expect(loss.json()).toMatchObject({ code: "invalid_pairing_code" });
    }
  });
});

function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const entry of list) {
    const part = String(entry).split(";")[0] ?? "";
    const [k, ...rest] = part.split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
