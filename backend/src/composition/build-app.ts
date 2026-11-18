import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { toFastifyTrustProxy, type Config } from "../config.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "../routes/health.js";
import { pairingCodeRoutes } from "../routes/pairing-codes.js";
import { deviceRoutes } from "../routes/devices.js";
import { devicePlugin } from "../device/plugin.js";
import { rawBodyPlugin } from "../device/raw-body.js";
import type { DeviceAuthConfig } from "../device/config.js";
import { createPool } from "../adapters/db-postgres/pool.js";
import { sendProblem } from "../adapters/http-fastify/problems.js";
import { authPlugin, authRoutes, type AuthPluginOptions } from "../adapters/http-fastify/index.js";
import { buildAuthStack } from "./build-auth.js";

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
    trustProxy: toFastifyTrustProxy(config.trustProxy),
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

  const ownsPool = options.pool === undefined && Boolean(config.DATABASE_URL);
  const pool =
    options.pool !== undefined
      ? options.pool
      : config.DATABASE_URL
        ? createPool({ connectionString: config.DATABASE_URL })
        : null;

  if (ownsPool && pool) {
    app.addHook("onClose", async () => {
      await pool.end().catch(() => undefined);
    });
  }

  await app.register(rawBodyPlugin);

  const authConfig = options.auth?.config !== undefined ? options.auth.config : config.oidc;

  let authStack;
  try {
    authStack = await buildAuthStack({
      config: authConfig,
      pool,
      jwtVerifier: options.auth?.jwtVerifier,
      oidcProvider: options.auth?.oidcProvider ?? options.auth?.oidcClient,
      skipDiscovery: options.auth?.skipDiscovery ?? false,
    });
  } catch (err) {
    app.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "OIDC discovery failed at startup",
    );
    throw err;
  }

  await app.register(authPlugin, {
    config: authStack.config,
    pool,
    jwtVerifier: authStack.jwtVerifier,
    oidcProvider: authStack.oidcProvider,
    useCases: options.auth?.useCases ?? authStack.useCases,
    skipDiscovery: true,
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
