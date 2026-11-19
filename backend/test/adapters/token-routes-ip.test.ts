import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { AuthUseCases } from "../../src/adapters/http-fastify/auth-plugin.js";
import { buildApp } from "../../src/composition/build-app.js";
import { loadConfig } from "../../src/config.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_ID = "00000000-0000-4000-8000-000000000002";
const PEER = "192.0.2.10";
const PROXY = "10.0.0.5";
const SPOOFED = "198.51.100.77";

async function buildStubTokenApp(trustProxy: string): Promise<{
  app: FastifyInstance;
  capturedCreateIps: Array<string | null>;
  capturedRevokeIps: Array<string | null>;
}> {
  const capturedCreateIps: Array<string | null> = [];
  const capturedRevokeIps: Array<string | null> = [];

  const useCases: AuthUseCases = {
    startLogin: null,
    completeLogin: null,
    logout: null,
    getMe: null,
    resolveSession: null,
    resolveBearer: {
      execute: async () => ({ ownerId: OWNER_ID }),
    } as unknown as AuthUseCases["resolveBearer"],
    resolveOwnerPat: null,
    createOwnerAccessToken: {
      execute: async (input: { clientIp?: string | null }) => {
        capturedCreateIps.push(input.clientIp ?? null);
        return {
          secret: "smsg_pat_test_secret",
          token: {
            id: TOKEN_ID,
            name: "test",
            createdAt: new Date("2026-11-19T00:00:00Z"),
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        };
      },
    } as unknown as AuthUseCases["createOwnerAccessToken"],
    listOwnerAccessTokens: null,
    revokeOwnerAccessToken: {
      execute: async (input: { clientIp?: string | null }) => {
        capturedRevokeIps.push(input.clientIp ?? null);
      },
    } as unknown as AuthUseCases["revokeOwnerAccessToken"],
  };

  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8080",
    LOG_LEVEL: "silent",
    TRUST_PROXY: trustProxy,
  });

  const app = await buildApp(config, {
    pool: {} as Pool,
    auth: {
      config: null,
      skipDiscovery: true,
      useCases,
    },
  });
  await app.ready();

  return { app, capturedCreateIps, capturedRevokeIps };
}

describe("tokenRoutes clientIp / TRUST_PROXY", () => {
  it("ignores spoofed and malformed X-Forwarded-For when TRUST_PROXY=false", async () => {
    const { app, capturedCreateIps, capturedRevokeIps } = await buildStubTokenApp("false");
    try {
      const createSpoofed = await app.inject({
        method: "POST",
        url: "/v1/tokens",
        remoteAddress: PEER,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": SPOOFED,
        },
        payload: { name: "agent-1" },
      });
      expect(createSpoofed.statusCode).toBe(201);

      const createMalformed = await app.inject({
        method: "POST",
        url: "/v1/tokens",
        remoteAddress: PEER,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": "garbage; drop",
        },
        payload: { name: "agent-2" },
      });
      expect(createMalformed.statusCode).toBe(201);

      const revokeSpoofed = await app.inject({
        method: "DELETE",
        url: `/v1/tokens/${TOKEN_ID}`,
        remoteAddress: PEER,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": "garbage; drop",
        },
      });
      expect(revokeSpoofed.statusCode).toBe(204);

      expect(capturedCreateIps).toEqual([PEER, PEER]);
      expect(capturedRevokeIps).toEqual([PEER]);
    } finally {
      await app.close();
    }
  });

  it("uses X-Forwarded-For only when immediate peer matches TRUST_PROXY", async () => {
    const { app, capturedCreateIps, capturedRevokeIps } = await buildStubTokenApp(PROXY);
    try {
      const trustedCreate = await app.inject({
        method: "POST",
        url: "/v1/tokens",
        remoteAddress: PROXY,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": SPOOFED,
        },
        payload: { name: "agent-trusted" },
      });
      expect(trustedCreate.statusCode).toBe(201);

      const untrustedRevoke = await app.inject({
        method: "DELETE",
        url: `/v1/tokens/${TOKEN_ID}`,
        remoteAddress: PEER,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": SPOOFED,
        },
      });
      expect(untrustedRevoke.statusCode).toBe(204);

      const trustedRevoke = await app.inject({
        method: "DELETE",
        url: `/v1/tokens/${TOKEN_ID}`,
        remoteAddress: PROXY,
        headers: {
          authorization: "Bearer jwt-token",
          "x-forwarded-for": SPOOFED,
        },
      });
      expect(trustedRevoke.statusCode).toBe(204);

      expect(capturedCreateIps).toEqual([SPOOFED]);
      expect(capturedRevokeIps).toEqual([PEER, SPOOFED]);
    } finally {
      await app.close();
    }
  });
});
