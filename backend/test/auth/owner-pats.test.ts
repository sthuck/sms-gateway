import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import { sha256Hex } from "../../src/adapters/auth-oidc/crypto.js";
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

describe.skipIf(!migratorOk)("owner personal access tokens", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let queue: MemoryQueuePublisher;
  let userApi: OpenApiDoc;
  let aliceSession: string;
  let aliceCsrf: string;
  let aliceId: string;
  let bobId: string;
  let bobBearer: string;
  let bodyCodec: AesGcmBodyCodec;
  let aliceDeviceId: string;
  let aliceMsgId: string;
  let bobMsgId: string;
  let alicePat: { id: string; secret: string };

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

    aliceDeviceId = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Alice phone', '{}'::jsonb, 'active') RETURNING id`,
        [aliceId],
      )
    ).rows[0]!.id;

    aliceMsgId = await seedMessage({
      ownerId: aliceId,
      deviceId: aliceDeviceId,
      deviceMsgId: "alice-m1",
      sender: "+1000",
      body: "alice secret sms",
    });

    const bobDeviceId = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Bob phone', '{}'::jsonb, 'active') RETURNING id`,
        [bobId],
      )
    ).rows[0]!.id;
    bobMsgId = await seedMessage({
      ownerId: bobId,
      deviceId: bobDeviceId,
      deviceMsgId: "bob-m1",
      sender: "+2000",
      body: "bob secret sms",
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function seedMessage(opts: {
    ownerId: string;
    deviceId: string;
    deviceMsgId: string;
    sender: string;
    body: string;
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
         ) VALUES ($1, $2, $3, $4, $5, now(), 0, 'inbound')
         RETURNING id`,
        [opts.ownerId, opts.deviceId, opts.deviceMsgId, opts.sender, Buffer.from(ciphertext)],
      );
      return inserted.rows[0]!.id;
    });
  }

  function sessionHeaders(): Record<string, string> {
    return {
      cookie: `sms_session=${aliceSession}; sms_csrf=${aliceCsrf}`,
      "x-csrf-token": aliceCsrf,
      origin: "http://127.0.0.1:8080",
    };
  }

  it("create returns secret once; list never does; hash at rest", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...sessionHeaders(), "content-type": "application/json" },
      payload: { name: "agent" },
    });
    expect(created.statusCode).toBe(201);
    expectOpenApiResponse(userApi, "/v1/tokens", "post", created, {
      status: 201,
      contentType: "application/json",
    });
    const body = created.json() as {
      id: string;
      token: string;
      name: string;
    };
    expect(body.token.startsWith("smsg_pat_")).toBe(true);
    expect(body.token).toContain(body.id);
    alicePat = { id: body.id, secret: body.token };

    const listed = await app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: sessionHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expectOpenApiResponse(userApi, "/v1/tokens", "get", listed, {
      status: 200,
      contentType: "application/json",
    });
    const listBody = listed.json() as { tokens: Array<Record<string, unknown>> };
    expect(listBody.tokens.some((t) => t.id === body.id)).toBe(true);
    for (const t of listBody.tokens) {
      expect(t).not.toHaveProperty("token");
      expect(t).not.toHaveProperty("token_hash");
      expect(JSON.stringify(t)).not.toContain("smsg_pat_");
    }

    const db = await admin.query<{ token_hash: string; name: string }>(
      `SELECT token_hash, name FROM owner_access_tokens WHERE id = $1`,
      [body.id],
    );
    expect(db.rows[0]!.name).toBe("agent");
    expect(db.rows[0]!.token_hash).toBe(sha256Hex(body.token));
    expect(db.rows[0]!.token_hash).not.toContain("smsg_pat_");
  });

  it("Bearer PAT works on the three read routes with full inbox", async () => {
    const headers = { authorization: `Bearer ${alicePat.secret}` };

    const list = await app.inject({ method: "GET", url: "/v1/messages?limit=10", headers });
    expect(list.statusCode).toBe(200);
    const messages = (list.json() as { messages: Array<{ id: string; body: string }> }).messages;
    expect(messages.some((m) => m.id === aliceMsgId)).toBe(true);
    expect(messages.some((m) => m.body === "alice secret sms")).toBe(true);
    expect(messages.some((m) => m.id === bobMsgId)).toBe(false);

    const one = await app.inject({ method: "GET", url: `/v1/messages/${aliceMsgId}`, headers });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { body: string }).body).toBe("alice secret sms");

    const devices = await app.inject({ method: "GET", url: "/v1/devices", headers });
    expect(devices.statusCode).toBe(200);
    const deviceList = (devices.json() as { devices: Array<{ id: string }> }).devices;
    expect(deviceList.some((d) => d.id === aliceDeviceId)).toBe(true);
  });

  it("Bearer rejected for revoked/unknown/malformed with same 401", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer smsg_pat_00000000-0000-4000-8000-000000000099_nope",
      },
    });
    expectAuthProblem(userApi, "/v1/messages", "get", unknown, 401);
    expect((unknown.json() as { code: string }).code).toBe("unauthorized");

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { authorization: "Bearer smsg_pat_not-a-uuid_x" },
    });
    expectAuthProblem(userApi, "/v1/messages", "get", malformed, 401);
    expect(malformed.json()).toEqual(unknown.json());

    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/tokens/${alicePat.id}`,
      headers: sessionHeaders(),
    });
    expect(revoke.statusCode).toBe(204);

    const revoked = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${alicePat.secret}` },
    });
    expectAuthProblem(userApi, "/v1/messages", "get", revoked, 401);
    expect(revoked.json()).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("owner A PAT cannot see B; A cannot list/revoke B tokens (404)", async () => {
    const createA = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...sessionHeaders(), "content-type": "application/json" },
      payload: { name: "a2" },
    });
    const aSecret = (createA.json() as { token: string }).token;

    const cross = await app.inject({
      method: "GET",
      url: `/v1/messages/${bobMsgId}`,
      headers: { authorization: `Bearer ${aSecret}` },
    });
    expect(cross.statusCode).toBe(404);

    const bobCreate = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${bobBearer}`,
        "content-type": "application/json",
      },
      payload: { name: "bob-token" },
    });
    expect(bobCreate.statusCode).toBe(201);
    const bobTokenId = (bobCreate.json() as { id: string }).id;

    const listAsAlice = await app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: sessionHeaders(),
    });
    const ids = (listAsAlice.json() as { tokens: Array<{ id: string }> }).tokens.map((t) => t.id);
    expect(ids).not.toContain(bobTokenId);

    const revokeBob = await app.inject({
      method: "DELETE",
      url: `/v1/tokens/${bobTokenId}`,
      headers: sessionHeaders(),
    });
    expect(revokeBob.statusCode).toBe(404);
  });

  it("PAT cannot call write routes or token routes", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...sessionHeaders(), "content-type": "application/json" },
      payload: { name: "write-check" },
    });
    const secret = (create.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${secret}` };

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${aliceMsgId}`,
      headers,
    });
    expect(del.statusCode).toBe(403);
    expect((del.json() as { code: string }).code).toBe("forbidden");

    const streams = await app.inject({ method: "GET", url: "/v1/streams", headers });
    expect(streams.statusCode).toBe(403);
    expect((streams.json() as { code: string }).code).toBe("forbidden");

    const tokenList = await app.inject({ method: "GET", url: "/v1/tokens", headers });
    expectAuthProblem(userApi, "/v1/tokens", "get", tokenList, 403);

    const tokenCreate = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...headers, "content-type": "application/json" },
      payload: { name: "nope" },
    });
    expectAuthProblem(userApi, "/v1/tokens", "post", tokenCreate, 403);

    const revokeDevice = await app.inject({
      method: "POST",
      url: `/v1/devices/${aliceDeviceId}/revoke`,
      headers,
    });
    expect(revokeDevice.statusCode).toBe(403);
    expect((revokeDevice.json() as { code: string }).code).toBe("forbidden");
  });

  it("audit rows on create and revoke; never the secret", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...sessionHeaders(), "content-type": "application/json" },
      payload: { name: "audited" },
    });
    const { id, token } = created.json() as { id: string; token: string };

    const createAudit = await withOwner(appPool, aliceId, async (client) => {
      const { rows } = await client.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id::text FROM audit_log
         WHERE action = 'token.create' ORDER BY at DESC LIMIT 1`,
      );
      return rows[0]!;
    });
    expect(createAudit.action).toBe("token.create");
    expect(createAudit.actor_id).toBe(aliceId);

    await app.inject({
      method: "DELETE",
      url: `/v1/tokens/${id}`,
      headers: sessionHeaders(),
    });

    const revokeAudit = await withOwner(appPool, aliceId, async (client) => {
      const { rows } = await client.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = 'token.revoke' ORDER BY at DESC LIMIT 1`,
      );
      return rows[0]!;
    });
    expect(revokeAudit.action).toBe("token.revoke");

    const allAudit = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE owner_id = $1 AND action LIKE 'token.%'`,
      [aliceId],
    );
    for (const row of allAudit.rows) {
      expect(JSON.stringify(row)).not.toContain(token);
      expect(JSON.stringify(row)).not.toContain("smsg_pat_");
    }
  });

  it("NUL in sender/q returns 400", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...sessionHeaders(), "content-type": "application/json" },
      payload: { name: "nul-check" },
    });
    const secret = (created.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${secret}` };

    const senderNul = await app.inject({
      method: "GET",
      url: "/v1/messages?sender=" + encodeURIComponent("a\u0000b"),
      headers,
    });
    expect(senderNul.statusCode).toBe(400);
    expect((senderNul.json() as { code: string }).code).toBe("invalid_request");

    const qNul = await app.inject({
      method: "GET",
      url: "/v1/messages?q=" + encodeURIComponent("x\u0000y"),
      headers,
    });
    expect(qNul.statusCode).toBe(400);
    expect((qNul.json() as { code: string }).code).toBe("invalid_request");
  });
});
