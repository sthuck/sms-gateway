import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createRequire } from "node:module";
import SwaggerParser from "@apidevtools/swagger-parser";
import { buildApp } from "../../src/app.js";

const require = createRequire(import.meta.url);
// CJS interop under NodeNext — avoid default-import constructability issues.
const Ajv = require("ajv") as new (opts?: object) => {
  compile: (schema: object) => (data: unknown) => boolean;
};
const addFormats = require("ajv-formats") as (ajv: instanceType) => void;
type instanceType = InstanceType<typeof Ajv>;
import { loadConfig } from "../../src/config.js";
import { createJwtVerifier } from "../../src/adapters/auth-oidc/jwt.js";
import {
  ensureQueues,
  PgBossQueuePublisher,
  startBoss,
} from "../../src/adapters/queue-pgboss/index.js";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SESSION_SECRET = "test-only-session-secret-32chars!!";
const HOST = "10.0.2.2:8080";

type JsonSchema = Record<string, unknown>;

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        security?: Array<Record<string, string[]>>;
        responses: Record<
          string,
          {
            content?: Record<string, { schema?: JsonSchema }>;
          }
        >;
      }
    >
  >;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, unknown>;
  };
};

function responseSchema(
  doc: OpenApiDoc,
  pathKey: string,
  method: string,
  status: string,
  contentType = "application/json",
): JsonSchema {
  const schema = doc.paths[pathKey]?.[method]?.responses?.[status]?.content?.[contentType]?.schema;
  if (!schema) {
    throw new Error(`No schema for ${method.toUpperCase()} ${pathKey} → ${status}`);
  }
  return schema;
}

function compileValidator(_doc: OpenApiDoc, schema: JsonSchema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe.skipIf(!migratorOk)("OpenAPI contract shapes (STH-14 / STH-15 endpoints)", () => {
  let admin: Pool;
  let appPool: Pool;
  let mock: MockOidc;
  let app: FastifyInstance;
  let boss: PgBoss;
  let sessionCookie: string;
  let csrfCookie: string;
  let userApi: OpenApiDoc;
  let deviceApi: OpenApiDoc;

  beforeAll(async () => {
    userApi = (await SwaggerParser.dereference(
      path.join(repoRoot, "docs/contracts/user-api.yaml"),
    )) as unknown as OpenApiDoc;
    deviceApi = (await SwaggerParser.dereference(
      path.join(repoRoot, "docs/contracts/device-api.yaml"),
    )) as unknown as OpenApiDoc;

    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();

    boss = await startBoss({
      connectionString: appDatabaseUrl(),
      installSchema: false,
      applicationName: "test-contract",
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
        sub: "sub-contract",
        email: "contract@example.com",
        name: "Contract",
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

    const login = await app.inject({ method: "GET", url: "/v1/auth/login" });
    const oauthCookie = cookieValue(login, "sms_oauth")!;
    const idpRes = await fetch(login.headers.location!, { redirect: "manual" });
    const callbackPath = idpRes.headers.get("location")!.replace("http://127.0.0.1:8080", "");
    const callback = await app.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: `sms_oauth=${oauthCookie}` },
    });
    sessionCookie = `sms_session=${cookieValue(callback, "sms_session")}`;
    csrfCookie = `sms_csrf=${cookieValue(callback, "sms_csrf")}`;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await mock?.close();
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("POST /v1/pairing-codes response matches user-api.yaml", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      },
    });
    expect(res.statusCode).toBe(201);
    const validate = compileValidator(
      userApi,
      responseSchema(userApi, "/v1/pairing-codes", "post", "201"),
    );
    expect(validate(res.json())).toBe(true);
  });

  it("POST /v1/devices/pair success and error bodies match device-api.yaml", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      },
    });
    const code = (issued.json() as { code: string }).code;

    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: {
        name: "Google Pixel 8",
        platform: "android",
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
    const ok = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed.headers,
      payload: raw,
    });
    expect(ok.statusCode).toBe(201);
    const validateOk = compileValidator(
      deviceApi,
      responseSchema(deviceApi, "/v1/devices/pair", "post", "201"),
    );
    expect(validateOk(ok.json())).toBe(true);

    const signed2 = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: raw,
    });
    const bad = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: signed2.headers,
      payload: raw,
    });
    expect(bad.statusCode).toBe(400);
    const validateErr = compileValidator(
      deviceApi,
      responseSchema(deviceApi, "/v1/devices/pair", "post", "400", "application/problem+json"),
    );
    expect(validateErr(bad.json())).toBe(true);
    expect(bad.json()).toMatchObject({
      code: "invalid_pairing_code",
      retryable: false,
    });
  });

  it("POST /v1/devices/{id}/revoke matches user-api.yaml", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      },
    });
    const code = (issued.json() as { code: string }).code;
    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0", name: "Revoke Me" },
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
    const deviceId = (paired.json() as { device_id: string }).device_id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/devices/${deviceId}/revoke`,
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      },
    });
    expect(res.statusCode).toBe(204);
    expect(userApi.paths["/v1/devices/{id}/revoke"]?.post?.responses?.["204"]).toBeTruthy();
  });

  it("POST /v1/messages:batch success and error bodies match device-api.yaml", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: "http://127.0.0.1:8080",
        "x-csrf-token": csrfCookie.replace("sms_csrf=", ""),
      },
    });
    const code = (issued.json() as { code: string }).code;
    const pairBody = {
      pairing_code: code,
      alg: "ES256",
      public_key: testVector.testPublicKeySpkiB64url,
      device_info: { platform: "android", app_version: "1.0.0", name: "Contract Phone" },
    };
    const pairRaw = JSON.stringify(pairBody);
    const pairSigned = signDeviceRequest({
      method: "POST",
      path: "/v1/devices/pair",
      host: HOST,
      deviceId: "",
      body: pairRaw,
    });
    const paired = await app.inject({
      method: "POST",
      url: "/v1/devices/pair",
      headers: pairSigned.headers,
      payload: pairRaw,
    });
    const deviceId = (paired.json() as { device_id: string }).device_id;

    const batchBody = {
      messages: [
        {
          device_msg_id: "sms-contract-1",
          sender: "+15551234567",
          body: "Your code is 123456",
          received_at: "2026-11-18T09:45:12Z",
          sim_slot: 0,
          direction: "inbound",
        },
        {
          device_msg_id: "",
          sender: "+15551234567",
          body: "x",
          received_at: "2026-11-18T09:45:12Z",
          direction: "inbound",
        },
      ],
    };
    const raw = JSON.stringify(batchBody);
    const signed = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId,
      body: raw,
    });
    const ok = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: signed.headers,
      payload: raw,
    });
    expect(ok.statusCode).toBe(200);
    const validateOk = compileValidator(
      deviceApi,
      responseSchema(deviceApi, "/v1/messages:batch", "post", "200"),
    );
    const okBody = ok.json();
    expect(validateOk(okBody)).toBe(true);
    expect(ok.json()).toMatchObject({
      results: [
        { device_msg_id: "sms-contract-1", status: "accepted" },
        { device_msg_id: "", status: "rejected" },
      ],
    });

    const badSigned = signDeviceRequest({
      method: "POST",
      path: "/v1/messages:batch",
      host: HOST,
      deviceId,
      body: raw,
      timestamp: Math.floor(Date.now() / 1000) - 10_000,
    });
    const bad = await app.inject({
      method: "POST",
      url: "/v1/messages:batch",
      headers: badSigned.headers,
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);
    const validateErr = compileValidator(
      deviceApi,
      responseSchema(deviceApi, "/v1/messages:batch", "post", "401", "application/problem+json"),
    );
    expect(validateErr(bad.json())).toBe(true);
    expect(bad.json()).toMatchObject({ code: "invalid_timestamp", retryable: true });
  });

  it("OpenAPI request/response schemas exist for STH-14 / STH-15 / STH-21 endpoints", () => {
    expect(userApi.paths["/v1/pairing-codes"]?.post).toBeTruthy();
    expect(deviceApi.paths["/v1/devices/pair"]?.post).toBeTruthy();
    expect(userApi.paths["/v1/devices"]?.get).toBeTruthy();
    expect(userApi.paths["/v1/devices/{id}"]?.patch).toBeTruthy();
    expect(userApi.paths["/v1/devices/{id}/revoke"]?.post).toBeTruthy();
    expect(deviceApi.paths["/v1/devices/me"]?.get).toBeTruthy();
    expect(deviceApi.paths["/v1/messages:batch"]?.post).toBeTruthy();
    expect(userApi.paths["/v1/messages"]?.get).toBeTruthy();
    expect(userApi.paths["/v1/messages/{id}"]?.get).toBeTruthy();
    expect(userApi.paths["/v1/messages/{id}"]?.delete).toBeTruthy();
  });

  it("OpenAPI declares owner PAT endpoints and bearerAuth on read routes", () => {
    expect(userApi.components?.securitySchemes?.bearerAuth).toBeTruthy();
    expect(userApi.paths["/v1/tokens"]?.post).toBeTruthy();
    expect(userApi.paths["/v1/tokens"]?.get).toBeTruthy();
    expect(userApi.paths["/v1/tokens/{id}"]?.delete).toBeTruthy();

    const messageGetSec = userApi.paths["/v1/messages"]?.get?.security ?? [];
    const messageIdGetSec = userApi.paths["/v1/messages/{id}"]?.get?.security ?? [];
    const devicesGetSec = userApi.paths["/v1/devices"]?.get?.security ?? [];
    expect(messageGetSec.some((s) => "bearerAuth" in s)).toBe(true);
    expect(messageIdGetSec.some((s) => "bearerAuth" in s)).toBe(true);
    expect(devicesGetSec.some((s) => "bearerAuth" in s)).toBe(true);

    const tokenPostSec = userApi.paths["/v1/tokens"]?.post?.security ?? [];
    expect(tokenPostSec.some((s) => "bearerAuth" in s)).toBe(false);
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
