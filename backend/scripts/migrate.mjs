#!/usr/bin/env node
/**
 * Thin wrapper so migrations always use MIGRATE_DATABASE_URL when set,
 * falling back to DATABASE_URL. Keeps the app DATABASE_URL (sms_app) from
 * accidentally running DDL.
 *
 * On `migrate:up`:
 * - SMS_APP_PASSWORD is required (no hardcoded default).
 * - The sms_app password is set only when the role is newly created.
 *   Later ups never ALTER ROLE … PASSWORD. Rotate manually when needed:
 *     ALTER ROLE sms_app PASSWORD '…';
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

const appPassword = process.env.SMS_APP_PASSWORD;
if (direction === "up" && (!appPassword || appPassword.length === 0)) {
  console.error(
    "SMS_APP_PASSWORD is required for migrate:up (no default). " +
      "Set it explicitly — local Compose/CI use a labelled local-dev value; " +
      "production must use a secret. Rotating an existing role password is a " +
      "manual ALTER ROLE, not part of migrate:up.",
  );
  process.exit(1);
}

const args = ["node-pg-migrate", "-m", "migrations", "--ignore-pattern", ".*(README|\\.gitkeep).*"];
if (direction) {
  args.push(direction);
}
args.push(...process.argv.slice(3));

async function main() {
  let roleExistedBefore = false;
  if (direction === "up") {
    roleExistedBefore = await appRoleExists(databaseUrl);
  }

  const code = await runMigrate(args, databaseUrl);
  if (code !== 0) {
    process.exit(code);
  }

  if (direction === "up" && !roleExistedBefore) {
    try {
      await setAppRolePassword(databaseUrl, appPassword);
    } catch (err) {
      console.error("Failed to set sms_app password on first create:", err.message);
      process.exit(1);
    }
  }

  process.exit(0);
}

function runMigrate(migrateArgs, url) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", ...migrateArgs], {
      cwd: backendRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: url,
        // Pass through only when set; never invent a default.
        ...(appPassword ? { SMS_APP_PASSWORD: appPassword } : {}),
      },
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function appRoleExists(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'sms_app'`,
    );
    return rows.length > 0;
  } finally {
    await client.end();
  }
}

/**
 * Set sms_app password only for a newly created role.
 * ALTER ROLE PASSWORD does not accept bind parameters; pass via set_config + format(%L).
 */
async function setAppRolePassword(url, password) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
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

void main();
