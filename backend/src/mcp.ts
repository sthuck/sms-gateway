import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

/**
 * MCP server entrypoint stub.
 *
 * Future work: expose stream read tools via the official MCP TypeScript
 * SDK with scoped auth. No tools or transport yet.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  log.info(
    {
      role: "mcp",
      nodeEnv: config.NODE_ENV,
    },
    "mcp stub started; SDK wiring not implemented yet",
  );

  const shutdown = (signal: string) => {
    log.info({ signal }, "mcp stub shutting down");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {
    /* run until signal */
  });
}

void main();
