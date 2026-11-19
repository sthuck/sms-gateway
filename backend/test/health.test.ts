import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { expectHealthBody } from "./helpers/openapi.js";

describe("health endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
    });
    app = await buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /healthz returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expectHealthBody(res, "ok");
  });

  it("GET /readyz returns ready when no DB pool is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expectHealthBody(res, "ready");
  });

  it("GET /readyz runs SELECT 1 when a DB pool is configured and returns ready on success", async () => {
    const queries: string[] = [];
    const healthyPool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ "?column?": 1 }] };
      },
    } as unknown as Pool;

    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
    });
    const dbApp = await buildApp(config, {
      pool: healthyPool,
      auth: { config: null, skipDiscovery: true },
    });
    await dbApp.ready();
    try {
      const res = await dbApp.inject({ method: "GET", url: "/readyz" });
      expectHealthBody(res, "ready");
      expect(queries).toEqual(["SELECT 1"]);
    } finally {
      await dbApp.close();
    }
  });

  it("GET /readyz returns 503 problem+json on DB failure while /healthz stays 200 ok", async () => {
    const failingPool = {
      query: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Pool;

    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "8080",
      LOG_LEVEL: "silent",
    });
    const dbApp = await buildApp(config, {
      pool: failingPool,
      auth: { config: null, skipDiscovery: true },
    });
    await dbApp.ready();
    try {
      const health = await dbApp.inject({ method: "GET", url: "/healthz" });
      expectHealthBody(health, "ok");

      const ready = await dbApp.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(String(ready.headers["content-type"] ?? "")).toContain("application/problem+json");
      expect(ready.json()).toMatchObject({
        code: "service_unavailable",
        retryable: true,
        status: 503,
        instance: "/readyz",
      });
    } finally {
      await dbApp.close();
    }
  });
});
