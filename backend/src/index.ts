import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ensureQueues, loadQueueConfig, startBoss } from "./queue/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const queueConfig = loadQueueConfig();
  const app = await buildApp(config);

  let boss: Awaited<ReturnType<typeof startBoss>> | undefined;
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
}

void main();
