import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { buildLoggerOptions } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { pairingCodeRoutes } from "./routes/pairing-codes.js";
import { deviceRoutes } from "./routes/devices.js";
import { authPlugin, type AuthPluginOptions } from "./auth/plugin.js";
import { devicePlugin } from "./device/plugin.js";
import { rawBodyPlugin } from "./device/raw-body.js";
import type { DeviceAuthConfig } from "./device/config.js";
import { createPool } from "./db/pool.js";
import { sendProblem } from "./http/problems.js";

export type BuildAppOptions = {
  pool?: Pool | null;
  auth?: Partial<AuthPluginOptions>;
  deviceAuth?: DeviceAuthConfig | null;
};

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(config.LOG_LEVEL),
    requestIdHeader: "x-request-id",
    bodyLimit: 1_048_576,
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

  if (config.corsAllowedOrigins.length > 0) {
    const allowed = new Set(config.corsAllowedOrigins);
    await app.register(cors, {
      origin(origin, cb) {
        if (!origin || allowed.has(origin)) {
          cb(null, true);
          return;
        }
        cb(null, false);
      },
      credentials: true,
    });
  }

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

  await app.register(rawBodyPlugin);

  await app.register(authPlugin, {
    config: options.auth?.config !== undefined ? options.auth.config : config.oidc,
    pool,
    jwtVerifier: options.auth?.jwtVerifier,
    oidcClient: options.auth?.oidcClient,
    skipDiscovery: options.auth?.skipDiscovery ?? false,
  });

  await app.register(devicePlugin, {
    config: options.deviceAuth !== undefined ? options.deviceAuth : config.deviceAuth,
  });

  app.setErrorHandler((err, request, reply) => {
    const statusCode =
      typeof err === "object" && err && "statusCode" in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 500;
    const instance = request.url.split("?")[0] ?? request.url;
    if (statusCode === 400) {
      return sendProblem(reply, "invalid_request", 400, "Malformed request", {
        instance,
      });
    }
    if (statusCode === 413) {
      return sendProblem(reply, "payload_too_large", 413, "Request body exceeds 1 MiB", {
        instance,
      });
    }
    request.log.error({ err: err instanceof Error ? err.message : String(err) }, "unhandled error");
    return sendProblem(reply, "internal_error", 500, "Unexpected error", {
      retryable: true,
      instance,
    });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(pairingCodeRoutes);
  await app.register(deviceRoutes);

  return app;
}
