import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/auth/jwt.js";
import { ensureQueues, startBoss } from "../../src/queue/index.js";
import { upsertMessagesInTx } from "../../src/ingest/batch.js";
import { encryptBody } from "../../src/ingest/encrypt-body.js";
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

describe.skipIf(!migratorOk)("message ingestion (STH-15)", () => {
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
      boss,
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
  ): Promise<{ statusCode: number; json: unknown; headers: Record<string, unknown> }> {
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
    return { statusCode: res.statusCode, json: res.json(), headers: res.headers };
  }

  function msg(
    id: string,
    overrides: Partial<{
      sender: string;
      body: string;
      received_at: string;
      sim_slot: number | null;
      direction: string;
      owner_id: string;
      device_id: string;
    }> = {},
  ) {
    return {
      device_msg_id: id,
      sender: overrides.sender ?? "+15551234567",
      body: overrides.body ?? "hello",
      received_at: overrides.received_at ?? "2026-11-18T09:45:12Z",
      sim_slot: overrides.sim_slot === undefined ? 0 : overrides.sim_slot,
      direction: overrides.direction ?? "inbound",
      ...(overrides.owner_id !== undefined ? { owner_id: overrides.owner_id } : {}),
      ...(overrides.device_id !== undefined ? { device_id: overrides.device_id } : {}),
    };
  }

  it("stores a batch of N messages and resend creates no duplicates or extra events", async () => {
    const deviceId = await pairDevice();
    const n = 5;
    const messages = Array.from({ length: n }, (_, i) => msg(`batch-n-${i}`));

    const first = await postBatch(deviceId, messages);
    expect(first.statusCode).toBe(200);
    const firstResults = (first.json as { results: Array<{ status: string; id: string }> }).results;
    expect(firstResults).toHaveLength(n);
    expect(firstResults.every((r) => r.status === "accepted")).toBe(true);

    const countAfterFirst = await admin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM messages WHERE device_id = $1`,
      [deviceId],
    );
    expect(Number(countAfterFirst.rows[0]?.c)).toBe(n);

    const jobsAfterFirst = await boss.findJobs("message.created", {
      data: { device_id: deviceId },
    });
    expect(jobsAfterFirst).toHaveLength(n);

    const second = await postBatch(deviceId, messages);
    expect(second.statusCode).toBe(200);
    const secondResults = (second.json as { results: Array<{ status: string; id: string }> })
      .results;
    expect(secondResults.every((r) => r.status === "duplicate")).toBe(true);
    expect(secondResults.map((r) => r.id).sort()).toEqual(firstResults.map((r) => r.id).sort());

    const countAfterSecond = await admin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM messages WHERE device_id = $1`,
      [deviceId],
    );
    expect(Number(countAfterSecond.rows[0]?.c)).toBe(n);

    const jobsAfterSecond = await boss.findJobs("message.created", {
      data: { device_id: deviceId },
    });
    expect(jobsAfterSecond).toHaveLength(n);
  });

  it("rejects invalid items individually without failing the batch", async () => {
    const deviceId = await pairDevice();
    const messages = [
      msg("ok-1"),
      {
        device_msg_id: "",
        sender: "+1",
        body: "x",
        received_at: "2026-11-18T09:45:12Z",
        direction: "inbound",
      },
      msg("ok-1"), // duplicate_in_batch
      msg("bad-dir", { direction: "sideways" }),
      msg("future", { received_at: "2099-01-01T00:00:00Z" }),
      msg("big-body", { body: "x".repeat(32_769) }),
      msg("ok-2", { sender: "BankAlert" }),
      msg("national", { sender: "5551234567" }),
    ];

    const res = await postBatch(deviceId, messages);
    expect(res.statusCode).toBe(200);
    const results = (res.json as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(messages.length);
    expect(results[0]).toMatchObject({ device_msg_id: "ok-1", status: "accepted" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      error: { code: "missing_field" },
    });
    expect(results[2]).toMatchObject({
      device_msg_id: "ok-1",
      status: "rejected",
      error: { code: "duplicate_in_batch" },
    });
    expect(results[3]).toMatchObject({
      status: "rejected",
      error: { code: "invalid_field" },
    });
    expect(results[4]).toMatchObject({
      status: "rejected",
      error: { code: "invalid_field" },
    });
    expect(results[5]).toMatchObject({
      status: "rejected",
      error: { code: "body_too_large" },
    });
    expect(results[6]).toMatchObject({ device_msg_id: "ok-2", status: "accepted" });
    expect(results[7]).toMatchObject({ device_msg_id: "national", status: "accepted" });

    const stored = await admin.query<{ device_msg_id: string; sender: string }>(
      `SELECT device_msg_id, sender FROM messages WHERE device_id = $1 ORDER BY device_msg_id`,
      [deviceId],
    );
    expect(stored.rows.map((r) => r.device_msg_id)).toEqual(["national", "ok-1", "ok-2"]);
    expect(stored.rows.find((r) => r.device_msg_id === "ok-2")?.sender).toBe("BankAlert");
    expect(stored.rows.find((r) => r.device_msg_id === "national")?.sender).toBe("+15551234567");
  });

  it("takes owner_id only from the device credential, never the payload", async () => {
    const deviceId = await pairDevice();
    const fakeOwner = "00000000-0000-4000-8000-000000000099";
    const fakeDevice = "00000000-0000-4000-8000-000000000098";
    const res = await postBatch(deviceId, [
      msg("inject-1", { owner_id: fakeOwner, device_id: fakeDevice }),
    ]);
    expect(res.statusCode).toBe(200);
    const result = (res.json as { results: Array<{ status: string; id: string }> }).results[0]!;
    expect(result.status).toBe("accepted");

    const row = await admin.query<{ owner_id: string; device_id: string }>(
      `SELECT owner_id, device_id FROM messages WHERE id = $1`,
      [result.id],
    );
    expect(row.rows[0]?.owner_id).toBe(ownerId);
    expect(row.rows[0]?.owner_id).not.toBe(fakeOwner);
    expect(row.rows[0]?.device_id).toBe(deviceId);
    expect(row.rows[0]?.device_id).not.toBe(fakeDevice);
  });

  it("concurrent identical batches create each row once and publish each event once", async () => {
    const deviceId = await pairDevice();
    const messages = [msg("conc-1"), msg("conc-2"), msg("conc-3")];

    const [a, b] = await Promise.all([
      postBatch(deviceId, messages),
      postBatch(deviceId, messages),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const statuses = [
      ...(a.json as { results: Array<{ status: string; id: string }> }).results,
      ...(b.json as { results: Array<{ status: string; id: string }> }).results,
    ];
    const byMsg = new Map<string, { accepted: number; duplicate: number; ids: Set<string> }>();
    for (const r of [
      ...(a.json as { results: Array<{ device_msg_id: string; status: string; id: string }> })
        .results,
      ...(b.json as { results: Array<{ device_msg_id: string; status: string; id: string }> })
        .results,
    ]) {
      const entry = byMsg.get(r.device_msg_id) ?? {
        accepted: 0,
        duplicate: 0,
        ids: new Set<string>(),
      };
      if (r.status === "accepted") entry.accepted += 1;
      if (r.status === "duplicate") entry.duplicate += 1;
      entry.ids.add(r.id);
      byMsg.set(r.device_msg_id, entry);
    }
    for (const [, entry] of byMsg) {
      expect(entry.accepted).toBe(1);
      expect(entry.duplicate).toBe(1);
      expect(entry.ids.size).toBe(1);
    }
    void statuses;

    const count = await admin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM messages WHERE device_id = $1`,
      [deviceId],
    );
    expect(Number(count.rows[0]?.c)).toBe(3);

    const jobs = await boss.findJobs("message.created", { data: { device_id: deviceId } });
    const forThese = jobs.filter((j) => {
      const data = j.data as { message_id?: string };
      return data.message_id !== undefined;
    });
    // Exactly one event per message for this device (may include prior tests' jobs
    // filtered by device_id — findJobs already scopes by device_id).
    expect(forThese).toHaveLength(3);
  });

  it("rolled-back batch leaves no message row and no event", async () => {
    const deviceId = await pairDevice();
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
      await upsertMessagesInTx(boss, client, {
        ownerId,
        deviceId,
        items: [
          {
            kind: "valid",
            index: 0,
            value: {
              deviceMsgId: "rollback-1",
              sender: "+15550001111",
              body: "should not persist",
              receivedAt: new Date("2026-11-18T09:45:12Z"),
              simSlot: 0,
              direction: "inbound",
            },
          },
        ],
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const rows = await admin.query(
      `SELECT 1 FROM messages WHERE device_id = $1 AND device_msg_id = 'rollback-1'`,
      [deviceId],
    );
    expect(rows.rows).toHaveLength(0);

    const jobs = await boss.findJobs("message.created", { data: { device_id: deviceId } });
    expect(jobs.filter((j) => (j.data as { message_id?: string }).message_id)).toHaveLength(0);
  });

  it("updates devices.last_seen_at on successful ingest", async () => {
    const deviceId = await pairDevice();
    await admin.query(`UPDATE devices SET last_seen_at = NULL WHERE id = $1`, [deviceId]);
    const res = await postBatch(deviceId, [msg("seen-1")]);
    expect(res.statusCode).toBe(200);
    const row = await admin.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM devices WHERE id = $1`,
      [deviceId],
    );
    expect(row.rows[0]?.last_seen_at).toBeTruthy();
  });

  it("enforces payload and batch size limits", async () => {
    const deviceId = await pairDevice();

    const tooMany = Array.from({ length: 101 }, (_, i) => msg(`limit-${i}`));
    const over = await postBatch(deviceId, tooMany);
    expect(over.statusCode).toBe(413);
    expect(over.json).toMatchObject({ code: "batch_too_large", retryable: false });

    const huge = "x".repeat(1_048_577);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId,
      body: huge,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("rate-limits per device with Retry-After", async () => {
    const deviceId = await pairDevice();
    // Override ingest limits on a dedicated tiny-limit app would be heavy;
    // instead fill the bucket directly then assert 429.
    await consumeUntilDenied(deviceId);

    const res = await postBatch(deviceId, [msg("rate-1")]);
    expect(res.statusCode).toBe(429);
    expect(res.json).toMatchObject({ code: "rate_limited", retryable: true });
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("encryptBody is currently an identity placeholder writing body_ciphertext", () => {
    const bytes = encryptBody(ownerId, "secret-body");
    expect(bytes.equals(Buffer.from("secret-body", "utf8"))).toBe(true);
  });

  async function consumeUntilDenied(deviceId: string): Promise<void> {
    // Drive the request limiter to exhaustion with a temporary tight config
    // by writing the bucket as if the window is full.
    await admin.query(
      `INSERT INTO app.rate_limit_buckets (bucket_key, window_start, hit_count, locked_until)
       VALUES ($1, now(), 1000, NULL)
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_start = EXCLUDED.window_start, hit_count = EXCLUDED.hit_count`,
      [`ingest:req:${deviceId}`],
    );
  }
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
