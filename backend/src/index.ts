import { buildApp } from "./composition/index.js";
import { loadConfig } from "./config.js";
import {
  ensureQueues,
  loadQueueConfig,
  PgBossQueuePublisher,
  startBoss,
} from "./adapters/queue-pgboss/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const queueConfig = loadQueueConfig();

  let boss: Awaited<ReturnType<typeof startBoss>> | undefined;
  let queuePublisher: PgBossQueuePublisher | null = null;
  if (config.DATABASE_URL) {
    boss = await startBoss({
      connectionString: config.DATABASE_URL,
      queueConfig,
      installSchema: false,
      applicationName: "sms-gateway-api",
      // API is a publisher only; skip maintenance timers on this process.
      supervise: false,
      schedule: false,
    });
    await ensureQueues(boss, { queueConfig });
    queuePublisher = new PgBossQueuePublisher(boss);
  }

  const app = await buildApp(config, { queuePublisher });

  if (boss) {
    app.log.info({ schema: queueConfig.QUEUE_SCHEMA }, "queue publisher ready (publishInTx)");
  } else {
    app.log.warn("DATABASE_URL unset; queue publisher not started");
  }

  const stopBoss = async () => {
    if (!boss) {
      return;
    }
    try {
      await boss.stop({ graceful: true, timeout: 5_000 });
    } catch (err) {
      app.log.error({ err }, "error stopping queue publisher");
    }
  };

  app.addHook("onClose", async () => {
    await stopBoss();
  });

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(
      { host: config.HOST, port: config.PORT },
      "API listening (reachable from Android emulator at http://10.0.2.2:%s)",
      config.PORT,
    );
  } catch (err) {
    await stopBoss();
    app.log.error(err, "failed to start API");
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "API shutting down; closing HTTP server and dependencies");
    const forceExitTimer = setTimeout(() => {
      app.log.error({ signal }, "API graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 25_000);
    forceExitTimer.unref();
    try {
      await app.close();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "error during API shutdown",
      );
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main();
