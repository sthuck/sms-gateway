import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { buildLoggerOptions } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { authPlugin, type AuthPluginOptions } from "./auth/plugin.js";
import { createPool } from "./db/pool.js";

export type BuildAppOptions = {
  pool?: Pool | null;
  auth?: Partial<AuthPluginOptions>;
};

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(config.LOG_LEVEL),
    requestIdHeader: "x-request-id",
  });

  // Extra guard: never attach raw bodies to request logs.
  app.addHook("onRequest", async (request) => {
    request.log = request.log.child({
      req: {
        method: request.method,
        url: request.url,
      },
    });
  });

  const pool =
    options.pool !== undefined
      ? options.pool
      : config.DATABASE_URL
        ? createPool({ connectionString: config.DATABASE_URL })
        : null;

  if (pool) {
    app.addHook("onClose", async () => {
      await pool.end().catch(() => undefined);
    });
  }

  await app.register(authPlugin, {
    config: options.auth?.config !== undefined ? options.auth.config : config.oidc,
    pool,
    jwtVerifier: options.auth?.jwtVerifier,
    oidcClient: options.auth?.oidcClient,
    skipDiscovery: options.auth?.skipDiscovery ?? false,
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);

  return app;
}
