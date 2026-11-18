import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(
      { host: config.HOST, port: config.PORT },
      "API listening (reachable from Android emulator at http://10.0.2.2:%s)",
      config.PORT,
    );
  } catch (err) {
    app.log.error(err, "failed to start API");
    process.exit(1);
  }
}

void main();
