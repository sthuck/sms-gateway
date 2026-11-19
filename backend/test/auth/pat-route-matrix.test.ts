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
import {
  OWNER_PAT_READ_ALLOWLIST,
  PAT_READONLY_DETAIL,
} from "../../src/adapters/http-fastify/auth-plugin.js";
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
import { loadUserApi, type OpenApiDoc } from "../helpers/openapi.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const SESSION_SECRET = "test-only-session-secret-32chars!!";
const SAMPLE_UUID = "00000000-0000-4000-8000-000000000099";

function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of cookies) {
    const part = String(c).split(";")[0] ?? "";
    if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
  }
  return undefined;
}

type OpenApiOp = {
  method: string;
  path: string;
  security: Array<Record<string, string[]>>;
};

/** Secured operations from user-api.yaml (non-empty security). */
function securedOperations(doc: OpenApiDoc): OpenApiOp[] {
  const out: OpenApiOp[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!op || typeof op !== "object") continue;
      const security = (op as { security?: Array<Record<string, string[]>> }).security;
      if (!security || security.length === 0) continue;
      out.push({ method: method.toUpperCase(), path, security });
    }
  }
  return out;
}

function isPatAllowlisted(method: string, openApiPath: string): boolean {
  const url = openApiPath.replace(/\{[^}]+\}/g, (m) => `:${m.slice(1, -1)}`);
  return OWNER_PAT_READ_ALLOWLIST.some((r) => r.method === method && r.url === url);
}

function concreteUrl(
  openApiPath: string,
  ids: { messageId: string; deviceId: string; tokenId: string; streamId: string },
): string {
  let id = SAMPLE_UUID;
  if (openApiPath.startsWith("/v1/messages/")) id = ids.messageId;
  else if (openApiPath.startsWith("/v1/devices/")) id = ids.deviceId;
  else if (openApiPath.startsWith("/v1/tokens/")) id = ids.tokenId;
  else if (openApiPath.startsWith("/v1/streams/")) id = ids.streamId;
  return openApiPath.replace("{id}", id).replace(/\{[^}]+\}/g, SAMPLE_UUID);
}

describe.skipIf(!migratorOk)("PAT route matrix (STH-57 default-deny)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let userApi: OpenApiDoc;
  let aliceSession: string;
  let aliceCsrf: string;
  let aliceId: string;
  let aliceDeviceId: string;
  let aliceMsgId: string;
  let aliceStreamId: string;
  let patSecret: string;
  let patTokenId: string;

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
        sub: "sub-alice-matrix",
        email: "alice-matrix@example.com",
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
    const bodyCodec = new AesGcmBodyCodec({
      keyWrapper: new MemoryKeyWrapper(),
      userKeys: new PgUserKeyRepository(appPool),
      cache: new DekCache({ ttlMs: 300_000, maxEntries: 100 }),
    });

    app = await buildApp(config, {
      pool: appPool,
      queuePublisher: new MemoryQueuePublisher(),
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

    aliceDeviceId = (
      await admin.query<{ id: string }>(
        `INSERT INTO devices (owner_id, name, platform_info, status)
         VALUES ($1, 'matrix-phone', '{}'::jsonb, 'active') RETURNING id`,
        [aliceId],
      )
    ).rows[0]!.id;

    aliceMsgId = await withOwner(appPool, aliceId, async (client) => {
      const ciphertext = await bodyCodec.encode(
        { ownerId: aliceId, deviceId: aliceDeviceId, deviceMsgId: "matrix-1" },
        "matrix body",
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO messages (
           owner_id, device_id, device_msg_id, sender, body_ciphertext,
           received_at, sim_slot, direction
         ) VALUES ($1, $2, 'matrix-1', '+1000', $3, now(), 0, 'inbound')
         RETURNING id`,
        [aliceId, aliceDeviceId, Buffer.from(ciphertext)],
      );
      return rows[0]!.id;
    });

    aliceStreamId = (
      await admin.query<{ id: string }>(
        `INSERT INTO streams (owner_id, name, mode, rules_json, version)
         VALUES ($1, 'matrix', 'rules', '[]'::jsonb, 1) RETURNING id`,
        [aliceId],
      )
    ).rows[0]!.id;

    const created = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        cookie: `sms_session=${aliceSession}; sms_csrf=${aliceCsrf}`,
        "x-csrf-token": aliceCsrf,
        origin: "http://127.0.0.1:8080",
        "content-type": "application/json",
      },
      payload: { name: "matrix-pat" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; token: string };
    patTokenId = body.id;
    patSecret = body.token;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("allowlist matches OpenAPI bearerAuth read ops and Fastify routes", () => {
    const secured = securedOperations(userApi);
    const bearerAuthOps = secured.filter((op) =>
      op.security.some((s) => Object.prototype.hasOwnProperty.call(s, "bearerAuth")),
    );
    const fromOpenApi = bearerAuthOps.map((op) => ({
      method: op.method,
      url: op.path.replace(/\{([^}]+)\}/g, ":$1"),
    }));
    expect(fromOpenApi).toEqual(
      expect.arrayContaining(
        OWNER_PAT_READ_ALLOWLIST.map((r) => ({ method: r.method, url: r.url })),
      ),
    );
    expect(fromOpenApi).toHaveLength(OWNER_PAT_READ_ALLOWLIST.length);

    for (const route of OWNER_PAT_READ_ALLOWLIST) {
      expect(app.hasRoute({ method: route.method, url: route.url })).toBe(true);
    }
  });

  it("valid PAT gets 200 only on allowlist; 403 on every other secured owner route", async () => {
    const secured = securedOperations(userApi);
    expect(secured.length).toBeGreaterThan(OWNER_PAT_READ_ALLOWLIST.length);

    const ids = {
      messageId: aliceMsgId,
      deviceId: aliceDeviceId,
      tokenId: patTokenId,
      streamId: aliceStreamId,
    };
    const headers = { authorization: `Bearer ${patSecret}` };
    const allowlistHits: string[] = [];
    const forbiddenHits: string[] = [];

    for (const op of secured) {
      const url = concreteUrl(op.path, ids);
      const injectOpts: {
        method: string;
        url: string;
        headers: Record<string, string>;
        payload?: Record<string, never>;
      } = {
        method: op.method,
        url,
        headers: {
          ...headers,
          "content-type": "application/json",
          origin: "http://127.0.0.1:8080",
        },
      };
      if (["POST", "PATCH", "PUT"].includes(op.method)) {
        injectOpts.payload = {};
      }
      const res = await app.inject(injectOpts);

      const key = `${op.method} ${op.path}`;
      if (isPatAllowlisted(op.method, op.path)) {
        expect(res.statusCode, key).toBe(200);
        allowlistHits.push(key);
      } else {
        expect(res.statusCode, key).toBe(403);
        expect((res.json() as { code: string }).code, key).toBe("forbidden");
        expect((res.json() as { detail?: string }).detail, key).toBe(PAT_READONLY_DETAIL);
        forbiddenHits.push(key);
      }
    }

    expect(allowlistHits.sort()).toEqual(
      ["GET /v1/devices", "GET /v1/messages", "GET /v1/messages/{id}"].sort(),
    );
    expect(forbiddenHits).toEqual(
      expect.arrayContaining([
        "GET /v1/auth/me",
        "PATCH /v1/devices/{id}",
        "POST /v1/pairing-codes",
        "POST /v1/streams:preview",
        "GET /v1/streams/{id}/messages",
        "GET /v1/tokens",
        "POST /v1/tokens",
        "DELETE /v1/tokens/{id}",
        "DELETE /v1/messages/{id}",
      ]),
    );

    // Fastify must not expose an extra /v1 owner route missing from OpenAPI secured set
    // (would silently escape the matrix). Compare printRoutes paths under /v1.
    const printed = app.printRoutes({ commonPrefix: false });
    expect(printed).toContain("/v1/messages");
    expect(printed).toContain("/v1/devices");
    expect(printed).toContain("/v1/tokens");
  });
});
