import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { toFastifyTrustProxy, type Config } from "../config.js";
import { buildLoggerOptions } from "../logger.js";
import { healthRoutes } from "../routes/health.js";
import { createPool } from "../adapters/db-postgres/pool.js";
import {
  authPlugin,
  authRoutes,
  devicePlugin,
  deviceRoutes,
  messageRoutes,
  pairingCodeRoutes,
  rawBodyPlugin,
  sendProblem,
  type AuthPluginOptions,
  type DeviceUseCases,
} from "../adapters/http-fastify/index.js";
import type { DeviceAuthConfig } from "../adapters/device-crypto/config.js";
import type { IngestConfig } from "../adapters/ingest/index.js";
import type { QueuePublisher } from "../ports/outbound/queue-publisher.js";
import { buildAuthStack } from "./build-auth.js";
import { buildDeviceStack } from "./build-device.js";

export type BuildAppOptions = {
  pool?: Pool | null;
  auth?: Partial<AuthPluginOptions>;
  deviceAuth?: DeviceAuthConfig | null;
  deviceUseCases?: DeviceUseCases | null;
  queuePublisher?: QueuePublisher | null;
  ingest?: IngestConfig;
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
      oidcProvider: options.auth?.oidcProvider,
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

  const deviceConfig = options.deviceAuth !== undefined ? options.deviceAuth : config.deviceAuth;
  const queuePublisher = options.queuePublisher !== undefined ? options.queuePublisher : null;
  const deviceStack = buildDeviceStack({
    config: deviceConfig,
    pool,
    queuePublisher,
    ingestConfig: options.ingest ?? config.ingest,
  });

  await app.register(devicePlugin, {
    config: deviceStack.config,
    useCases: options.deviceUseCases !== undefined ? options.deviceUseCases : deviceStack.useCases,
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
  await app.register(messageRoutes);

  return app;
}
