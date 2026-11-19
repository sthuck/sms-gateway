import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import {
  CreateStream,
  DeleteStream,
  GetStream,
  ListStreamMessages,
  ListStreams,
  PreviewStream,
  UpdateStream,
} from "../../src/application/use-cases/index.js";
import { IdentityBodyCodec } from "../../src/adapters/body-codec/index.js";
import { PgMessageRepository } from "../../src/adapters/db-postgres/message-repository.js";
import { PgStreamRepository } from "../../src/adapters/db-postgres/stream-repository.js";
import { Re2SafeRegexCompiler } from "../../src/adapters/re2/index.js";
import { MemoryQueuePublisher } from "../application/fakes/memory-ports.js";
import { withOwner } from "../../src/adapters/db-postgres/with-owner.js";
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

describe.skipIf(!migratorOk)("streams owner API (STH-23)", () => {
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
    const streams = new PgStreamRepository(appPool, queue);
    const messages = new PgMessageRepository(appPool, queue);
    const regex = new Re2SafeRegexCompiler();
    const bodyCodec = new IdentityBodyCodec();

    app = await buildApp(config, {
      pool: appPool,
      queuePublisher: queue,
      auth: {
        config: config.oidc,
        jwtVerifier,
        skipDiscovery: false,
      },
      streamUseCases: {
        createStream: new CreateStream({ streams, regex }),
        listStreams: new ListStreams({ streams }),
        getStream: new GetStream({ streams }),
        updateStream: new UpdateStream({ streams, regex }),
        deleteStream: new DeleteStream({ streams }),
        previewStream: new PreviewStream({ messages, bodyCodec, regex }),
        listStreamMessages: new ListStreamMessages({ streams, bodyCodec }),
      },
    });
    await app.ready();

    // Alice via session login
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

    // Bob via admin insert + bearer
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

  function aliceHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: `sms_session=${aliceSession}; sms_csrf=${aliceCsrf}`,
      origin: "http://127.0.0.1:8080",
      "x-csrf-token": aliceCsrf,
      "content-type": "application/json",
      ...extra,
    };
  }

  it("CRUD + OpenAPI shapes for owner A", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: aliceHeaders(),
      payload: {
        name: "OTPs",
        mode: "rules",
        rules_json: [{ type: "body_keyword", match: "any", keywords: ["OTP"] }],
      },
    });
    const body = expectOpenApiResponse(userApi, "/v1/streams", "post", created, {
      status: 201,
      contentType: "application/json",
    }) as { id: string; version: number; name: string };
    expect(body.version).toBe(1);
    expect(body.name).toBe("OTPs");

    const listed = await app.inject({
      method: "GET",
      url: "/v1/streams?limit=10",
      cookies: { sms_session: aliceSession },
    });
    expectOpenApiResponse(userApi, "/v1/streams", "get", listed, {
      status: 200,
      contentType: "application/json",
    });

    const got = await app.inject({
      method: "GET",
      url: `/v1/streams/${body.id}`,
      cookies: { sms_session: aliceSession },
    });
    expectOpenApiResponse(userApi, "/v1/streams/{id}", "get", got, {
      status: 200,
      contentType: "application/json",
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/streams/${body.id}`,
      headers: aliceHeaders(),
      payload: { name: "OTP renamed" },
    });
    const renamedBody = expectOpenApiResponse(userApi, "/v1/streams/{id}", "patch", renamed, {
      status: 200,
      contentType: "application/json",
    }) as { version: number; name: string };
    expect(renamedBody.version).toBe(1);
    expect(renamedBody.name).toBe("OTP renamed");
    expect(queue.published).toHaveLength(0);

    const redefined = await app.inject({
      method: "PATCH",
      url: `/v1/streams/${body.id}`,
      headers: aliceHeaders(),
      payload: {
        rules_json: [{ type: "sender_equals", value: "Bank" }],
      },
    });
    const redefinedBody = expectOpenApiResponse(userApi, "/v1/streams/{id}", "patch", redefined, {
      status: 200,
      contentType: "application/json",
    }) as { version: number; id: string };
    expect(redefinedBody.version).toBe(2);
    expect(queue.published).toEqual([
      {
        type: "stream.reclassify",
        owner_id: aliceId,
        stream_id: body.id,
        version: 2,
      },
    ]);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/streams/${body.id}`,
      headers: aliceHeaders(),
    });
    expect(del.statusCode).toBe(204);
  });

  it("rejects malicious regex with field-pathed 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: aliceHeaders(),
      payload: {
        name: "Evil",
        mode: "rules",
        rules_json: [{ type: "body_regex", pattern: "(a+)+$" }],
      },
    });
    const problem = expectAuthProblem(userApi, "/v1/streams", "post", res, 400) as {
      code: string;
      errors?: Array<{ path: string }>;
    };
    expect(problem.code).toBe("invalid_request");
    expect(problem.errors?.[0]?.path).toBe("rules_json[0].pattern");
  });

  it("RLS: owner B cannot read/patch/delete owner A's stream (404)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: aliceHeaders(),
      payload: { name: "Private", mode: "rules", rules_json: [] },
    });
    const { id } = created.json() as { id: string };

    const get = await app.inject({
      method: "GET",
      url: `/v1/streams/${id}`,
      headers: { authorization: `Bearer ${bobBearer}` },
    });
    expectAuthProblem(userApi, "/v1/streams/{id}", "get", get, 404);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/streams/${id}`,
      headers: {
        authorization: `Bearer ${bobBearer}`,
        "content-type": "application/json",
      },
      payload: { name: "Stolen" },
    });
    expectAuthProblem(userApi, "/v1/streams/{id}", "patch", patch, 404);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/streams/${id}`,
      headers: { authorization: `Bearer ${bobBearer}` },
    });
    expectAuthProblem(userApi, "/v1/streams/{id}", "delete", del, 404);

    // Still present for Alice
    const still = await app.inject({
      method: "GET",
      url: `/v1/streams/${id}`,
      cookies: { sms_session: aliceSession },
    });
    expect(still.statusCode).toBe(200);
    void bobId;
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/streams" });
    expectAuthProblem(userApi, "/v1/streams", "get", res, 401);
  });

  it("POST /v1/streams:preview matches OpenAPI and rejects bad rules", async () => {
    const deviceId = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Alice phone', '{}'::jsonb, 'active') RETURNING id`,
        [aliceId],
      )
    ).rows[0]!.id;

    await withOwner(appPool, aliceId, async (client) => {
      for (let i = 0; i < 5; i += 1) {
        const body = i % 2 === 0 ? Buffer.from("OTP bank", "utf8") : Buffer.from("hello", "utf8");
        await client.query(
          `INSERT INTO messages (
             owner_id, device_id, device_msg_id, sender, body_ciphertext,
             received_at, sim_slot, direction
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'inbound')`,
          [
            aliceId,
            deviceId,
            `preview-${i}`,
            "+1555",
            body,
            new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          ],
        );
      }
    });

    // Bob's message must not be evaluated
    const bobDevice = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'Bob phone', '{}'::jsonb, 'active') RETURNING id`,
        [bobId],
      )
    ).rows[0]!.id;
    await withOwner(appPool, bobId, async (client) => {
      await client.query(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext,
           received_at, sim_slot, direction
         ) VALUES ($1, $2, 'bob-otp', 'Bank', $3, now(), 0, 'inbound')`,
        [bobId, bobDevice, Buffer.from("OTP only for bob", "utf8")],
      );
    });

    const preview = await app.inject({
      method: "POST",
      url: "/v1/streams:preview",
      headers: aliceHeaders(),
      payload: {
        mode: "hybrid",
        rules_json: [{ type: "body_keyword", match: "any", keywords: ["OTP"] }],
        ai_prompt: "classify bank",
        limit: 50,
      },
    });
    const body = expectOpenApiResponse(userApi, "/v1/streams:preview", "post", preview, {
      status: 200,
      contentType: "application/json",
    }) as {
      evaluated: number;
      matched: number;
      ai_evaluated: boolean;
      note: string | null;
      matches: Array<{ message_id: string }>;
    };
    expect(body.matched).toBe(3);
    expect(body.ai_evaluated).toBe(false);
    expect(body.note).toMatch(/AI part not evaluated/i);
    expect(body.matches.every((m) => typeof m.message_id === "string")).toBe(true);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/streams:preview",
      headers: aliceHeaders(),
      payload: {
        mode: "rules",
        rules_json: [{ type: "body_regex", pattern: "(a+)+$" }],
      },
    });
    const problem = expectAuthProblem(userApi, "/v1/streams:preview", "post", bad, 400) as {
      errors?: Array<{ path: string }>;
    };
    expect(problem.errors?.[0]?.path).toBe("rules_json[0].pattern");
  });

  it("GET /v1/streams/{id}/messages: cursor pages + RLS 404 for other owner", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: aliceHeaders(),
      payload: { name: "Membership", mode: "rules", rules_json: [] },
    });
    const streamId = (created.json() as { id: string }).id;

    const deviceId = (
      await admin.query<{ id: string }>(`SELECT id FROM devices WHERE owner_id = $1 LIMIT 1`, [
        aliceId,
      ])
    ).rows[0]?.id;
    const ensuredDevice =
      deviceId ??
      (
        await admin.query<{ id: string }>(
          `INSERT INTO devices (owner_id, name, platform_info, status)
           VALUES ($1, 'Msg phone', '{}'::jsonb, 'active') RETURNING id`,
          [aliceId],
        )
      ).rows[0]!.id;

    const messageIds: string[] = [];
    await withOwner(appPool, aliceId, async (client) => {
      for (let i = 0; i < 5; i += 1) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO messages (
             owner_id, device_id, device_msg_id, sender, body_ciphertext,
             received_at, sim_slot, direction
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'inbound')
           RETURNING id`,
          [
            aliceId,
            ensuredDevice,
            `mem-${i}`,
            `+100${i}`,
            Buffer.from(`member-${i}`, "utf8"),
            new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
          ],
        );
        messageIds.push(inserted.rows[0]!.id);
        await client.query(
          `INSERT INTO stream_membership (
             stream_id, message_id, owner_id, matched_by, confidence, stream_version
           ) VALUES ($1, $2, $3, 'rule', 1.0, 1)`,
          [streamId, inserted.rows[0]!.id, aliceId],
        );
      }
    });

    const page1 = await app.inject({
      method: "GET",
      url: `/v1/streams/${streamId}/messages?limit=2`,
      cookies: { sms_session: aliceSession },
    });
    const p1 = expectOpenApiResponse(userApi, "/v1/streams/{id}/messages", "get", page1, {
      status: 200,
      contentType: "application/json",
    }) as {
      messages: Array<{ id: string; body: string }>;
      next_cursor: string | null;
    };
    expect(p1.messages).toHaveLength(2);
    expect(p1.messages[0]?.body).toBe("member-4");
    expect(p1.next_cursor).toBeTruthy();

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/streams/${streamId}/messages?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`,
      cookies: { sms_session: aliceSession },
    });
    const p2 = expectOpenApiResponse(userApi, "/v1/streams/{id}/messages", "get", page2, {
      status: 200,
      contentType: "application/json",
    }) as {
      messages: Array<{ id: string; body: string }>;
      next_cursor: string | null;
    };
    expect(p2.messages.map((m) => m.body)).toEqual(["member-2", "member-1"]);

    const page3 = await app.inject({
      method: "GET",
      url: `/v1/streams/${streamId}/messages?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`,
      cookies: { sms_session: aliceSession },
    });
    const p3 = page3.json() as { messages: Array<{ id: string }>; next_cursor: string | null };
    expect(p3.messages).toHaveLength(1);
    expect(p3.next_cursor).toBeNull();

    const seen = new Set([...p1.messages, ...p2.messages, ...p3.messages].map((m) => m.id));
    expect(seen.size).toBe(5);
    expect([...seen].sort()).toEqual([...messageIds].sort());

    const bobGet = await app.inject({
      method: "GET",
      url: `/v1/streams/${streamId}/messages`,
      headers: { authorization: `Bearer ${bobBearer}` },
    });
    expectAuthProblem(userApi, "/v1/streams/{id}/messages", "get", bobGet, 404);
  });

  it("preview requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/streams:preview",
      headers: { "content-type": "application/json" },
      payload: { mode: "rules", rules_json: [] },
    });
    expectAuthProblem(userApi, "/v1/streams:preview", "post", res, 401);
  });
});
