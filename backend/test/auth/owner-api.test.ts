import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import { AesGcmBodyCodec, DekCache } from "../../src/adapters/body-codec/index.js";
import { MemoryKeyWrapper } from "../../src/adapters/key-wrapper/index.js";
import { PgUserKeyRepository } from "../../src/adapters/db-postgres/user-key-repository.js";
import { withOwner } from "../../src/adapters/db-postgres/with-owner.js";
import { MemoryQueuePublisher } from "../application/fakes/memory-ports.js";
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
import {
  expectAuthProblem,
  expectOpenApiResponse,
  loadUserApi,
  type OpenApiDoc,
} from "../helpers/openapi.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";

function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of cookies) {
    const part = String(c).split(";")[0] ?? "";
    if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
  }
  return undefined;
}

describe.skipIf(!migratorOk)("owner messages + devices API (STH-21)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let queue: MemoryQueuePublisher;
  let userApi: OpenApiDoc;
  let aliceSession: string;
  let aliceCsrf: string;
  let bobBearer: string;
  let aliceId: string;
  let bobId: string;
  let bodyCodec: AesGcmBodyCodec;

  beforeAll(async () => {
    userApi = await loadUserApi();
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();
    queue = new MemoryQueuePublisher();

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
    bodyCodec = new AesGcmBodyCodec({
      keyWrapper: new MemoryKeyWrapper(),
      userKeys: new PgUserKeyRepository(appPool),
      cache: new DekCache({ ttlMs: 300_000, maxEntries: 100 }),
    });

    app = await buildApp(config, {
      pool: appPool,
      queuePublisher: queue,
      bodyCodec,
      auth: {
        config: config.oidc,
        jwtVerifier,
        skipDiscovery: false,
      },
    });
    await app.ready();

    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const idpRes = await fetch(login.headers.location!, { redirect: "manual" });
    const callbackPath = idpRes.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      cookies: { sms_oauth: oauthCookie },
    });
    aliceSession = cookieValue(callback, "sms_session")!;
    aliceCsrf = cookieValue(callback, "sms_csrf")!;

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { sms_session: aliceSession },
    });
    aliceId = (me.json() as { id: string }).id;

    bobId = (
      await admin.query<{ id: string }>(
        `INSERT INTO users (email, mfa_enrolled) VALUES ('bob@example.com', true) RETURNING id`,
      )
    ).rows[0]!.id;
    await admin.query(`UPDATE users SET owner_id = id WHERE id = $1`, [bobId]);
    await admin.query(`INSERT INTO user_identities (owner_id, issuer, sub) VALUES ($1, $2, $3)`, [
      bobId,
      mock.issuer,
      "sub-bob",
    ]);
    bobBearer = await mock.signToken({
      sub: "sub-bob",
      email: "bob@example.com",
      amr: ["pwd", "otp"],
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  function aliceHeaders(): Record<string, string> {
    return {
      cookie: `sms_session=${aliceSession}; sms_csrf=${aliceCsrf}`,
      "x-csrf-token": aliceCsrf,
      "content-type": "application/json",
      origin: "http://127.0.0.1:8080",
    };
  }

  async function seedDevice(ownerId: string, name: string): Promise<string> {
    const row = await admin.query<{ id: string }>(
      `INSERT INTO devices (owner_id, name, platform_info, status)
       VALUES ($1, $2, '{}'::jsonb, 'active') RETURNING id`,
      [ownerId, name],
    );
    const deviceId = row.rows[0]!.id;
    await admin.query(
      `INSERT INTO device_credentials (owner_id, device_id, public_key)
       VALUES ($1, $2, $3)`,
      [ownerId, deviceId, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    );
    return deviceId;
  }

  async function seedMessage(opts: {
    ownerId: string;
    deviceId: string;
    deviceMsgId: string;
    sender: string;
    body: string;
    receivedAt: Date;
  }): Promise<string> {
    const ciphertext = await bodyCodec.encode(
      {
        ownerId: opts.ownerId,
        deviceId: opts.deviceId,
        deviceMsgId: opts.deviceMsgId,
      },
      opts.body,
    );
    return withOwner(appPool, opts.ownerId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext,
           received_at, sim_slot, direction
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'inbound')
         RETURNING id`,
        [
          opts.ownerId,
          opts.deviceId,
          opts.deviceMsgId,
          opts.sender,
          Buffer.from(ciphertext),
          opts.receivedAt.toISOString(),
        ],
      );
      return inserted.rows[0]!.id;
    });
  }

  it("GET /v1/messages cursor pagination is stable under concurrent inserts", async () => {
    const deviceId = await seedDevice(aliceId, "Alice phone");
    const originalIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      originalIds.push(
        await seedMessage({
          ownerId: aliceId,
          deviceId,
          deviceMsgId: `page-${i}`,
          sender: `+100${i}`,
          body: `msg-${i}`,
          receivedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)),
        }),
      );
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/messages?limit=2",
      cookies: { sms_session: aliceSession },
    });
    const p1 = expectOpenApiResponse(userApi, "/v1/messages", "get", page1, {
      status: 200,
      contentType: "application/json",
    }) as { messages: Array<{ id: string; body: string }>; next_cursor: string | null };
    expect(p1.messages.map((m) => m.body)).toEqual(["msg-5", "msg-4"]);

    // Concurrent inserts with newer timestamps must not create skips/dupes
    // among the already-seen older pages.
    await seedMessage({
      ownerId: aliceId,
      deviceId,
      deviceMsgId: "concurrent-new",
      sender: "+1999",
      body: "brand-new",
      receivedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, 99)),
    });

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/messages?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`,
      cookies: { sms_session: aliceSession },
    });
    const p2 = expectOpenApiResponse(userApi, "/v1/messages", "get", page2, {
      status: 200,
      contentType: "application/json",
    }) as { messages: Array<{ id: string; body: string }>; next_cursor: string | null };
    expect(p2.messages.map((m) => m.body)).toEqual(["msg-3", "msg-2"]);

    const page3 = await app.inject({
      method: "GET",
      url: `/v1/messages?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`,
      cookies: { sms_session: aliceSession },
    });
    const p3 = page3.json() as {
      messages: Array<{ id: string; body: string }>;
      next_cursor: string | null;
    };
    expect(p3.messages.map((m) => m.body)).toEqual(["msg-1", "msg-0"]);
    expect(p3.next_cursor).toBeNull();

    const seen = [...p1.messages, ...p2.messages, ...p3.messages].map((m) => m.id);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...originalIds].sort());
  });

  it("RLS: owner B cannot read/delete messages or rename/revoke devices (404)", async () => {
    const aliceDevice = await seedDevice(aliceId, "Private phone");
    const messageId = await seedMessage({
      ownerId: aliceId,
      deviceId: aliceDevice,
      deviceMsgId: "private-1",
      sender: "+15551212",
      body: "secret otp",
      receivedAt: new Date(Date.UTC(2026, 3, 1)),
    });

    const getMsg = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${bobBearer}` },
    });
    expectAuthProblem(userApi, "/v1/messages/{id}", "get", getMsg, 404);

    const delMsg = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${messageId}`,
      headers: {
        authorization: `Bearer ${bobBearer}`,
        origin: "http://127.0.0.1:8080",
      },
    });
    expectAuthProblem(userApi, "/v1/messages/{id}", "delete", delMsg, 404);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/devices/${aliceDevice}`,
      headers: {
        authorization: `Bearer ${bobBearer}`,
        "content-type": "application/json",
        origin: "http://127.0.0.1:8080",
      },
      payload: { name: "Stolen" },
    });
    expectAuthProblem(userApi, "/v1/devices/{id}", "patch", patch, 404);

    const revoke = await app.inject({
      method: "POST",
      url: `/v1/devices/${aliceDevice}/revoke`,
      headers: {
        authorization: `Bearer ${bobBearer}`,
        origin: "http://127.0.0.1:8080",
      },
    });
    expectAuthProblem(userApi, "/v1/devices/{id}/revoke", "post", revoke, 404);

    const still = await app.inject({
      method: "GET",
      url: `/v1/messages/${messageId}`,
      cookies: { sms_session: aliceSession },
    });
    expectOpenApiResponse(userApi, "/v1/messages/{id}", "get", still, {
      status: 200,
      contentType: "application/json",
    });
    void bobId;
  });

  it("GET /v1/messages?q= searches decrypted content (OpenAPI)", async () => {
    const deviceId = await seedDevice(aliceId, "Search phone");
    await seedMessage({
      ownerId: aliceId,
      deviceId,
      deviceMsgId: "s1",
      sender: "Bank",
      body: "Your OTP is 4242",
      receivedAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 1)),
    });
    await seedMessage({
      ownerId: aliceId,
      deviceId,
      deviceMsgId: "s2",
      sender: "Friend",
      body: "lunch?",
      receivedAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 2)),
    });
    await seedMessage({
      ownerId: aliceId,
      deviceId,
      deviceMsgId: "s3",
      sender: "Bank",
      body: "",
      receivedAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 3)),
    });

    const bobDevice = await seedDevice(bobId, "Bob phone");
    await seedMessage({
      ownerId: bobId,
      deviceId: bobDevice,
      deviceMsgId: "bob-otp",
      sender: "Bank",
      body: "OTP only for bob",
      receivedAt: new Date(Date.UTC(2026, 4, 1, 0, 0, 4)),
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/messages?device_id=${deviceId}&q=otp&limit=10`,
      cookies: { sms_session: aliceSession },
    });
    const body = expectOpenApiResponse(userApi, "/v1/messages", "get", res, {
      status: 200,
      contentType: "application/json",
    }) as { messages: Array<{ id: string; body: string; sender: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.body).toBe("Your OTP is 4242");

    const listed = await app.inject({
      method: "GET",
      url: `/v1/messages?device_id=${deviceId}&sender=Bank&limit=10`,
      cookies: { sms_session: aliceSession },
    });
    const bankMsgs = (
      expectOpenApiResponse(userApi, "/v1/messages", "get", listed, {
        status: 200,
        contentType: "application/json",
      }) as { messages: Array<{ id: string; body: string }> }
    ).messages;
    const empty = bankMsgs.find((m) => m.body === "");
    expect(empty).toBeTruthy();
    const getEmpty = await app.inject({
      method: "GET",
      url: `/v1/messages/${empty!.id}`,
      cookies: { sms_session: aliceSession },
    });
    expect(
      (
        expectOpenApiResponse(userApi, "/v1/messages/{id}", "get", getEmpty, {
          status: 200,
          contentType: "application/json",
        }) as { body: string }
      ).body,
    ).toBe("");

    const listDevices = await app.inject({
      method: "GET",
      url: "/v1/devices",
      cookies: { sms_session: aliceSession },
    });
    expectOpenApiResponse(userApi, "/v1/devices", "get", listDevices, {
      status: 200,
      contentType: "application/json",
    });

    const rename = await app.inject({
      method: "PATCH",
      url: `/v1/devices/${deviceId}`,
      headers: aliceHeaders(),
      payload: { name: "Renamed phone" },
    });
    const renamed = expectOpenApiResponse(userApi, "/v1/devices/{id}", "patch", rename, {
      status: 200,
      contentType: "application/json",
    }) as { name: string };
    expect(renamed.name).toBe("Renamed phone");
  });

  it("requires auth on owner message/device routes", async () => {
    expectAuthProblem(
      userApi,
      "/v1/messages",
      "get",
      await app.inject({ method: "GET", url: "/v1/messages" }),
      401,
    );
    expectAuthProblem(
      userApi,
      "/v1/devices",
      "get",
      await app.inject({ method: "GET", url: "/v1/devices" }),
      401,
    );
  });
});
