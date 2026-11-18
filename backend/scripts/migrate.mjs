#!/usr/bin/env node
/**
 * Thin wrapper so migrations always use MIGRATE_DATABASE_URL when set,
 * falling back to DATABASE_URL. Keeps the app DATABASE_URL (sms_app) from
 * accidentally running DDL. After a successful `up`, sets sms_app's password
 * via a parameterized query (never interpolated into migration SQL logs).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const direction = process.argv[2]; // up | down | undefined

const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set MIGRATE_DATABASE_URL (preferred) or DATABASE_URL for migrations.");
  process.exit(1);
}

const args = ["node-pg-migrate", "-m", "migrations", "--ignore-pattern", ".*(README|\\.gitkeep).*"];
if (direction) {
  args.push(direction);
}
args.push(...process.argv.slice(3));

const child = spawn("pnpm", ["exec", ...args], {
  cwd: backendRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SMS_APP_PASSWORD: process.env.SMS_APP_PASSWORD ?? "sms_app",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code !== 0) {
    process.exit(code ?? 1);
    return;
  }
  if (direction === "up") {
    void setAppRolePassword(databaseUrl).then(
      () => process.exit(0),
      (err) => {
        console.error("Failed to set sms_app password:", err.message);
        process.exit(1);
      },
    );
    return;
  }
  process.exit(0);
});

async function setAppRolePassword(url) {
  const password = process.env.SMS_APP_PASSWORD ?? "sms_app";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // ALTER ROLE PASSWORD does not accept bind parameters. Pass the value via
    // set_config + format(%L) inside one transaction so we never concatenate
    // the secret into a logged query string.
    await client.query("BEGIN");
    await client.query("SELECT set_config('sms.migrate_app_password', $1, true)", [password]);
    await client.query(`
      DO $pwd$
      BEGIN
        EXECUTE format(
          'ALTER ROLE sms_app PASSWORD %L',
          current_setting('sms.migrate_app_password', true)
        );
      END
      $pwd$;
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
