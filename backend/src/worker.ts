import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

/**
 * Queue worker entrypoint stub.
 *
 * Future work (STH-12): connect pg-boss to DATABASE_URL and consume
 * message.created (and related) jobs. No business logic yet.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  log.info(
    {
      role: "worker",
      nodeEnv: config.NODE_ENV,
      hasDatabaseUrl: Boolean(config.DATABASE_URL),
    },
    "worker stub started; waiting for queue implementation (STH-12)",
  );

  // Keep the process alive like a real worker would.
  const shutdown = (signal: string) => {
    log.info({ signal }, "worker stub shutting down");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {
    /* run until signal */
  });
}

void main();
