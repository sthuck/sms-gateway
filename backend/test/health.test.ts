import { afterAll, beforeAll, describe, it } from "vitest";
import type { FastifyInstance } from "fastify";
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

  it("GET /readyz returns ready", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expectHealthBody(res, "ready");
  });
});
