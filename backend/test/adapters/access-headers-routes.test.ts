import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { AuthUseCases } from "../../src/adapters/http-fastify/auth-plugin.js";
import type { DeviceUseCases } from "../../src/adapters/http-fastify/device-plugin.js";
import { CreateOwnerAccessToken, IssuePairingCode } from "../../src/application/use-cases/index.js";
import { buildApp } from "../../src/composition/build-app.js";
import { loadConfig } from "../../src/config.js";
import { decodeAccessHeadersParam } from "../../src/domain/access-headers.js";
import type { OwnerAccessToken } from "../../src/domain/auth/access-token.js";
import type { AuditRepository } from "../../src/ports/outbound/audit-repository.js";
import type { OwnerAccessTokenRepository } from "../../src/ports/outbound/owner-access-token-repository.js";
import {
  MemoryIdGenerator,
  MemoryPairingCodeRepository,
  MemoryTokenHasher,
} from "../application/fakes/memory-ports.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";

function stubTokenRepo(): OwnerAccessTokenRepository {
  return {
    insert: async () => undefined,
    list: async (): Promise<OwnerAccessToken[]> => [],
    revoke: async () => "missing",
    lookupById: async () => null,
    touchLastUsed: async () => undefined,
  };
}

function stubAuditRepo(): AuditRepository {
  return {
    append: async () => undefined,
  };
}

async function buildStubRouteApp(envOverrides: Record<string, string>): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8080",
    LOG_LEVEL: "silent",
    DEVICE_API_PUBLIC_URL: "https://sms.example",
    ...envOverrides,
  });

  const authUseCases: AuthUseCases = {
    startLogin: null,
    completeLogin: null,
    logout: null,
    getMe: null,
    resolveSession: null,
    resolveBearer: {
      execute: async () => ({ ownerId: OWNER_ID }),
    } as unknown as AuthUseCases["resolveBearer"],
    resolveOwnerPat: null,
    createOwnerAccessToken: new CreateOwnerAccessToken({
      tokens: stubTokenRepo(),
      audit: stubAuditRepo(),
      ids: new MemoryIdGenerator(),
      hasher: new MemoryTokenHasher(),
      agentAccessHeaders: config.clientAccess.agentHeaders,
    }),
    listOwnerAccessTokens: null,
    revokeOwnerAccessToken: null,
  };

  const deviceUseCases: DeviceUseCases = {
    issuePairingCode: new IssuePairingCode({
      pairingCodes: new MemoryPairingCodeRepository(),
      generateCode: () => "7K3M-9Q2P",
      normalizeCode: (raw) => raw.replace(/-/g, ""),
      hashCode: (norm) => `hash(${norm})`,
      ttlSeconds: config.deviceAuth.pairingCodeTtlSeconds,
      apiPublicUrl: config.deviceAuth.apiPublicUrl,
      deviceAccessHeaders: config.clientAccess.deviceHeaders,
    }),
    pairDevice: null,
    revokeDevice: null,
    listDevices: null,
    renameDevice: null,
    getDeviceMe: null,
    resolveDeviceAuth: null,
    ingestMessageBatch: null,
    listMessages: null,
    getMessage: null,
    deleteMessage: null,
  };

  const app = await buildApp(config, {
    pool: {} as Pool,
    auth: {
      config: null,
      skipDiscovery: true,
      useCases: authUseCases,
    },
    deviceUseCases,
  });
  await app.ready();
  return app;
}

describe("access-headers HTTP routes", () => {
  it("omits access_headers and sets has_access_headers=false + Cache-Control: no-store when unconfigured", async () => {
    const app = await buildStubRouteApp({});
    try {
      const pairingRes = await app.inject({
        method: "POST",
        url: "/v1/pairing-codes",
        headers: { authorization: "Bearer jwt-token" },
      });
      expect(pairingRes.statusCode).toBe(201);
      expect(pairingRes.headers["cache-control"]).toBe("no-store");
      const pairingBody = pairingRes.json() as Record<string, unknown>;
      expect(pairingBody.has_access_headers).toBe(false);
      expect(pairingBody.qr_payload).toBe(
        "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.example",
      );

      const tokenRes = await app.inject({
        method: "POST",
        url: "/v1/tokens",
        headers: { authorization: "Bearer jwt-token" },
        payload: { name: "agent-1" },
      });
      expect(tokenRes.statusCode).toBe(201);
      expect(tokenRes.headers["cache-control"]).toBe("no-store");
      const tokenBody = tokenRes.json() as Record<string, unknown>;
      expect("access_headers" in tokenBody).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("includes headers param + has_access_headers=true and access_headers when configured", async () => {
    const app = await buildStubRouteApp({
      DEVICE_CF_ACCESS_CLIENT_ID: "dev-id",
      DEVICE_CF_ACCESS_CLIENT_SECRET: "dev-secret",
      AGENT_CF_ACCESS_CLIENT_ID: "agent-id",
      AGENT_CF_ACCESS_CLIENT_SECRET: "agent-secret",
    });
    try {
      const pairingRes = await app.inject({
        method: "POST",
        url: "/v1/pairing-codes",
        headers: { authorization: "Bearer jwt-token" },
      });
      expect(pairingRes.statusCode).toBe(201);
      expect(pairingRes.headers["cache-control"]).toBe("no-store");
      const pairingBody = pairingRes.json() as {
        has_access_headers: boolean;
        qr_payload: string;
      };
      expect(pairingBody.has_access_headers).toBe(true);
      const parsedUri = new URL(pairingBody.qr_payload);
      expect(decodeAccessHeadersParam(parsedUri.searchParams.get("headers")!)).toEqual({
        "CF-Access-Client-Id": "dev-id",
        "CF-Access-Client-Secret": "dev-secret",
      });

      const tokenRes = await app.inject({
        method: "POST",
        url: "/v1/tokens",
        headers: { authorization: "Bearer jwt-token" },
        payload: { name: "agent-1" },
      });
      expect(tokenRes.statusCode).toBe(201);
      expect(tokenRes.headers["cache-control"]).toBe("no-store");
      const tokenBody = tokenRes.json() as {
        access_headers?: Record<string, string>;
      };
      expect(tokenBody.access_headers).toEqual({
        "CF-Access-Client-Id": "agent-id",
        "CF-Access-Client-Secret": "agent-secret",
      });
    } finally {
      await app.close();
    }
  });
});
