/**
 * Re-wrap user_keys for one owner under the active KEK (STH-20).
 *
 *   pnpm --filter @sms-gateway/backend encryption:rotate-kek -- --owner <uuid>
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/adapters/db-postgres/pool.js";
import { PgUserKeyRepository } from "../src/adapters/db-postgres/user-key-repository.js";
import { FileKekWrapper } from "../src/adapters/key-wrapper/file-kek-wrapper.js";
import { rotateKekForOwner } from "../src/application/use-cases/rotate-kek.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.owner) {
  console.log(`Usage: encryption:rotate-kek -- --owner <uuid>
Requires ENCRYPTION_ENABLED, KEK_FILE, KEK_ID, optional KEK_PREVIOUS, DATABASE_URL.`);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig();
if (!config.encryption.enabled) {
  console.error("ENCRYPTION_ENABLED must be true");
  process.exit(1);
}
if (!config.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool({ connectionString: config.DATABASE_URL });
try {
  const keyWrapper = FileKekWrapper.fromConfig(config.encryption);
  const userKeys = new PgUserKeyRepository(pool);
  const result = await rotateKekForOwner(values.owner, { userKeys, keyWrapper });
  console.log(JSON.stringify({ owner: values.owner, ...result }));
} finally {
  await pool.end();
}
