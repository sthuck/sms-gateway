import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import {
  ensureQueues,
  PgBossQueuePublisher,
  startBoss,
} from "../../src/adapters/queue-pgboss/index.js";
import { IngestMessageBatch } from "../../src/application/use-cases/ingest-message-batch.js";
import { IdentityBodyCodec } from "../../src/adapters/body-codec/index.js";
import { formatPhoneSender } from "../../src/adapters/phone/index.js";
import { PgIngestRateLimiter } from "../../src/adapters/db-postgres/pg-ingest-rate-limiter.js";
import { PgMessageRepository } from "../../src/adapters/db-postgres/message-repository.js";
import { InfrastructureError } from "../../src/domain/errors.js";
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
import { signDeviceRequest, testVector } from "../helpers/device-signing.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";
const HOST = "10.0.2.2:8080";

describe.skipIf(!migratorOk)("message ingestion integration (STH-15)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let boss: PgBoss;
  let sessionCookie: string;
  let csrfCookie: string;
  let ownerId: string;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();

    boss = await startBoss({
      connectionString: appDatabaseUrl(),
      installSchema: false,
      applicationName: "test-ingest",
      supervise: false,
      schedule: false,
      test: { __test__enableSpies: true },
    });
    await ensureQueues(boss);

    mock = await startMockOidc({
      clientId: "sms-gateway-test",
      clientSecret: "dev-only-test-client-secret",
      redirectUri: "http://127.0.0.1:8080/v1/auth/callback",
      defaultClaims: {
        sub: "sub-ingest",
        email: "ingest@example.com",
        name: "Ingest",
        amr: ["pwd", "otp"],
      },
    });

    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: appDatabaseUrl(),
      OIDC_ISSUER_URL: mock.issuer,
      OIDC_CLIENT_ID: "sms-gateway-test",
      OIDC_CLIENT_SECRET: "dev-only-test-client-secret",
      OIDC_REDIRECT_URI: "http://127.0.0.1:8080/v1/auth/callback",
      OIDC_AUDIENCE: "sms-gateway-test",
      SESSION_SECRET,
      REQUIRE_MFA: "true",
      OIDC_ALLOW_INSECURE: "true",
      PUBLIC_BASE_URL: "http://10.0.2.2:8080/",
      DEVICE_API_PUBLIC_URL: "http://10.0.2.2:8080",
      DEVICE_ALLOWED_HOSTS: "10.0.2.2:8080,api.sms-gateway.example",
      CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
      PAIR_RATE_LIMIT_PER_IP: "100",
      INGEST_RATE_LIMIT_PER_DEVICE: "1000",
      INGEST_MESSAGE_RATE_LIMIT: "100000",
      INGEST_DEFAULT_PHONE_REGION: "US",
    });

    app = await buildApp(config, {
      pool: appPool,
      queuePublisher: new PgBossQueuePublisher(boss),
      auth: {
        config: config.oidc,
        jwtVerifier: createJwtVerifier(config.oidc!, mock.jwksUri),
        skipDiscovery: false,
      },
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
    ownerId = (me.json() as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function completeLogin(): Promise<{ sessionCookie: string; csrfCookie: string }> {
    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const idpRes = await fetch(login.headers.location!, { redirect: "manual" });
    const callbackPath = idpRes.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: `sms_oauth=${oauthCookie}` },
    });
    return {
      sessionCookie: `sms_session=${cookieValue(callback, "sms_session")}`,
      csrfCookie: `sms_csrf=${cookieValue(callback, "sms_csrf")}`,
    };
  }

  function userHeaders(): Record<string, string> {
    return {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: "http://127.0.0.1:8080",
      "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
    };
  }

  async function pairDevice(): Promise<string> {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: userHeaders(),
    });
    const code = (issued.json() as { code: string }).code;
    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0", name: "Ingest Phone" },
    };
    const raw = JSON.stringify(pairBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const paired = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
    });
    expect(paired.statusCode).toBe(201);
    return (paired.json() as { device_id: string }).device_id;
  }

  async function postBatch(
    deviceId: string,
    messages: unknown[],
  ): Promise<{ statusCode: number; json: unknown }> {
    const raw = JSON.stringify({ messages });
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId,
      body: raw,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: raw,
    });
    return { statusCode: res.statusCode, json: res.json() };
  }

  function msg(id: string, overrides: Record<string, unknown> = {}) {
    return {
      device_msg_id: id,
      sender: "+15551234567",
      body: "hello",
      received_at: "2026-11-18T09:45:12Z",
      sim_slot: 0,
      direction: "inbound",
      ...overrides,
    };
  }

  it("idempotent upsert + event-once + RLS owner isolation", async () => {
    const deviceId = await pairDevice();
    const messages = [msg("idem-1"), msg("idem-2"), msg("idem-3")];

    const first = await postBatch(deviceId, messages);
    expect(first.statusCode).toBe(200);
    const firstResults = (first.json as { results: Array<{ status: string; id: string }> }).results;
    expect(firstResults.every((r) => r.status === "accepted")).toBe(true);

    const second = await postBatch(deviceId, messages);
    expect(second.statusCode).toBe(200);
    const secondResults = (second.json as { results: Array<{ status: string; id: string }> })
      .results;
    expect(secondResults.every((r) => r.status === "duplicate")).toBe(true);
    expect(secondResults.map((r) => r.id).sort()).toEqual(firstResults.map((r) => r.id).sort());

    const count = await admin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM messages WHERE device_id = $1`,
      [deviceId],
    );
    expect(Number(count.rows[0]?.c)).toBe(3);

    const jobs = await boss.findJobs("message.created", { data: { device_id: deviceId } });
    expect(jobs).toHaveLength(3);

    const otherOwner = await admin.query<{ id: string }>(
      `INSERT INTO users (email, mfa_enrolled) VALUES ($1, true) RETURNING id`,
      [`other-${deviceId}@example.com`],
    );
    const otherOwnerId = otherOwner.rows[0]!.id;
    await admin.query(`UPDATE users SET owner_id = id WHERE id = $1`, [otherOwnerId]);

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.owner_id', $1, true)", [otherOwnerId]);
      const rows = await client.query(`SELECT id FROM messages WHERE device_id = $1`, [deviceId]);
      expect(rows.rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const ownerClient = await appPool.connect();
    try {
      await ownerClient.query("BEGIN");
      await ownerClient.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
      const rows = await ownerClient.query(`SELECT id FROM messages WHERE device_id = $1`, [
        deviceId,
      ]);
      expect(rows.rows).toHaveLength(3);
      await ownerClient.query("ROLLBACK");
    } finally {
      ownerClient.release();
    }

    const seen = await admin.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM devices WHERE id = $1`,
      [deviceId],
    );
    expect(seen.rows[0]?.last_seen_at).toBeTruthy();
  });

  it("infra failure from queue publisher maps to retryable 5xx, not 4xx", async () => {
    const deviceId = await pairDevice();
    const failingPublisher = {
      async publishInTx(): Promise<string | null> {
        throw new InfrastructureError("forced queue outage");
      },
    };
    const useCase = new IngestMessageBatch({
      messages: new PgMessageRepository(appPool, failingPublisher),
      rateLimiter: new PgIngestRateLimiter(appPool, {
        defaultPhoneRegion: "US",
        rateLimitPerDevice: 1000,
        rateLimitWindowSec: 60,
        messageRateLimit: 100000,
        messageRateWindowSec: 3600,
      }),
      bodyCodec: new IdentityBodyCodec(),
      formatPhone: formatPhoneSender,
      defaultPhoneRegion: "US",
    });

    await expect(
      useCase.execute({
        ownerId,
        deviceId,
        rawMessages: [msg("infra-1")],
        now: new Date("2026-11-18T12:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(InfrastructureError);

    const rows = await admin.query(
      `SELECT 1 FROM messages WHERE device_id = $1 AND device_msg_id = 'infra-1'`,
      [deviceId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("measures p95 latency for a 100-message batch (inject)", async () => {
    const deviceId = await pairDevice();
    const samples: number[] = [];
    const warmup = 3;
    const iterations = 12;

    for (let i = 0; i < warmup + iterations; i++) {
      const messages = Array.from({ length: 100 }, (_, j) =>
        msg(`p95-${i}-${j}`, { body: `bench ${i}/${j}` }),
      );
      const t0 = performance.now();
      const res = await postBatch(deviceId, messages);
      const ms = performance.now() - t0;
      expect(res.statusCode).toBe(200);
      if (i >= warmup) samples.push(ms);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)]!;
    const p50 = samples[Math.min(samples.length - 1, Math.ceil(0.5 * samples.length) - 1)]!;
    // Soft assertion: keep a generous ceiling so CI flake does not fail the suite;
    // numbers are recorded for the PR description.
    expect(p95).toBeLessThan(5_000);
    console.info(
      JSON.stringify({
        event: "ingest_p95",
        samples: samples.length,
        batchSize: 100,
        p50_ms: Number(p50.toFixed(2)),
        p95_ms: Number(p95.toFixed(2)),
        mean_ms: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
      }),
    );
  }, 180_000);
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
