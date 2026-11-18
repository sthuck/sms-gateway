import { loadConfig } from "./config.js";
import { createPool } from "./adapters/db-postgres/pool.js";
import { createLogger } from "./logger.js";
import {
  deadLetterQueueName,
  ensureQueues,
  handleMessageCreated,
  handleStreamReclassify,
  loadQueueConfig,
  QueueMetrics,
  registerDeadLetterObserver,
  registerOwnerHandler,
  startBoss,
  startMetricsServer,
  type EventName,
} from "./adapters/queue-pgboss/index.js";

/**
 * Queue worker: pg-boss consumer with per-job `withOwner` RLS scope.
 *
 * SIGTERM/SIGINT: stop fetching, finish in-flight jobs up to
 * QUEUE_SHUTDOWN_TIMEOUT_MS, then exit.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const queueConfig = loadQueueConfig();
  const log = createLogger(config.LOG_LEVEL);

  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the worker");
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const metrics = new QueueMetrics();

  const boss = await startBoss({
    connectionString: config.DATABASE_URL,
    queueConfig,
    installSchema: false,
    applicationName: "sms-gateway-worker",
  });

  await ensureQueues(boss, { queueConfig });

  await registerOwnerHandler(boss, "message.created", handleMessageCreated, {
    pool,
    log,
    metrics,
    queueConfig,
  });
  await registerOwnerHandler(boss, "stream.reclassify", handleStreamReclassify, {
    pool,
    log,
    metrics,
    queueConfig,
  });

  for (const name of ["message.created", "stream.reclassify"] as EventName[]) {
    await registerDeadLetterObserver(boss, deadLetterQueueName(name), { log, metrics });
  }

  const metricsServer = await startMetricsServer({
    host: queueConfig.QUEUE_METRICS_HOST,
    port: queueConfig.QUEUE_METRICS_PORT,
    metrics,
    log,
  });

  log.info(
    {
      role: "worker",
      schema: queueConfig.QUEUE_SCHEMA,
      retryLimit: queueConfig.QUEUE_RETRY_LIMIT,
      metricsPort: metricsServer?.port ?? null,
    },
    "worker started; consuming queue jobs",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(
      { signal, timeoutMs: queueConfig.QUEUE_SHUTDOWN_TIMEOUT_MS, metrics: metrics.snapshot() },
      "worker shutting down; stopping fetch, finishing in-flight jobs",
    );
    try {
      await boss.stop({
        graceful: true,
        timeout: queueConfig.QUEUE_SHUTDOWN_TIMEOUT_MS,
      });
    } catch (err) {
      log.error({ err }, "error during boss.stop");
    }
    try {
      await metricsServer?.close();
    } catch (err) {
      log.error({ err }, "error closing metrics server");
    }
    try {
      await pool.end();
    } catch (err) {
      log.error({ err }, "error closing pool");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
