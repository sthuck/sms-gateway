#!/usr/bin/env node
/**
 * Thin migration wrapper.
 *
 * Commands:
 *   up              Apply pending Drizzle migrations, then bootstrap pg-boss.
 *                   SMS_APP_PASSWORD required. Sets sms_app password only when
 *                   the role did not exist before this run.
 *   baseline|stamp  For EXISTING DBs already at the legacy node-pg-migrate head
 *                   (pgmigrations complete, drizzle journal empty): record the
 *                   Drizzle baseline as applied WITHOUT re-running DDL.
 *                   created_at MUST be the journal entry's `when` (not wall-clock;
 *                   see drizzle-orm#5769). Refuses if legacy state / catalog
 *                   does not match the expected baseline.
 *
 * Drizzle has no `down`. Use restore-from-backup / recreate for rollbacks.
 * Never use `drizzle-kit push`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { captureCatalog, diffAgainstExpected, formatCatalogDiffs } from "./catalog-fingerprint.mjs";
import ownedTablesJson from "../src/adapters/db-postgres/owned-tables.json" with { type: "json" };

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.env.DRIZZLE_MIGRATIONS_FOLDER && process.env.NODE_ENV === "production") {
  console.error("DRIZZLE_MIGRATIONS_FOLDER is not allowed when NODE_ENV=production");
  process.exit(1);
}
const drizzleFolder = process.env.DRIZZLE_MIGRATIONS_FOLDER
  ? path.resolve(process.env.DRIZZLE_MIGRATIONS_FOLDER)
  : path.join(backendRoot, "drizzle");
const journalPath = path.join(drizzleFolder, "meta", "_journal.json");

const command = process.argv[2]; // up | baseline | stamp | undefined

const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set MIGRATE_DATABASE_URL (preferred) or DATABASE_URL for migrations.");
  process.exit(1);
}

const appPassword = process.env.SMS_APP_PASSWORD;

const LEGACY_EXPECTED_MIGRATIONS = [
  "1794998580617_initial-schema",
  "1794998600880_rls-policies",
  "1795000000000_auth-sessions",
  "1795001000000_queue-processed-jobs",
  "1795002000000_device-auth-support",
];

const OWNED_TABLES = ownedTablesJson;

/** Serialize concurrent migrate:up / stamp on the same database. */
const MIGRATE_LOCK_KEY = 872_014_001;

async function main() {
  if (command === "down") {
    console.error(
      "Drizzle migrations have no down. Recreate the database or restore a backup.\n" +
        "Legacy node-pg-migrate files under migrations-legacy/ are history only.",
    );
    process.exit(1);
  }

  if (command === "baseline" || command === "stamp") {
    try {
      await withMigrateLock(databaseUrl, async (client) => {
        await stampBaseline(client);
      });
      await bootstrapPgBoss();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "up" || command === undefined) {
    if (!appPassword || appPassword.length === 0) {
      console.error(
        "SMS_APP_PASSWORD is required for migrate:up (no default). " +
          "Set it explicitly — local Compose/CI use a labelled local-dev value; " +
          "production must use a secret. Rotating an existing role password is a " +
          "manual ALTER ROLE, not part of migrate:up.",
      );
      process.exit(1);
    }

    try {
      await withMigrateLock(databaseUrl, async (client) => {
        await assertNotLegacyNeedingStamp(client);
        const roleExistedBefore = await appRoleExistsOn(client);
        await runDrizzleMigrate(client);
        if (!roleExistedBefore) {
          await setAppRolePasswordOn(client, appPassword);
        }
      });
    } catch (err) {
      console.error(
        err instanceof Error && err.message.startsWith("legacy DB detected")
          ? err.message
          : `Drizzle migrate failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }

    try {
      await bootstrapPgBoss();
    } catch (err) {
      console.error("pg-boss bootstrap failed:", err.message);
      process.exit(1);
    }

    process.exit(0);
  }

  console.error(`Unknown migrate command: ${command}`);
  console.error("Usage: node scripts/migrate.mjs [up|baseline|stamp]");
  process.exit(1);
}

/**
 * @param {string} url
 * @param {(client: import('pg').Client) => Promise<void>} fn
 */
async function withMigrateLock(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    try {
      await fn(client);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/** @param {import('pg').Client} client */
async function runDrizzleMigrate(client) {
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: drizzleFolder });
  console.log("Drizzle migrations applied.");
}

/**
 * Stamp the baseline journal entry as applied without running its SQL.
 * created_at = journal.when (exact), hash = sha256 of the .sql file contents.
 * @param {import('pg').Client} client
 */
async function stampBaseline(client) {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entry = journal.entries?.[0];
  if (!entry || entry.tag !== "0000_baseline") {
    throw new Error("Expected drizzle/meta/_journal.json entry 0 tag=0000_baseline");
  }

  const sqlPath = path.join(drizzleFolder, `${entry.tag}.sql`);
  const sqlText = fs.readFileSync(sqlPath, "utf8");
  const hash = crypto.createHash("sha256").update(sqlText).digest("hex");
  const when = entry.when;

  const existing = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
  );
  if (existing.rows.length > 0) {
    const { rows } = await client.query(
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    if (rows.length === 1 && rows[0].hash === hash && Number(rows[0].created_at) === when) {
      console.log(
        `Already stamped baseline ${entry.tag} (when=${when}, hash=${hash.slice(0, 12)}…) — no-op.`,
      );
      return;
    }
    if (rows.length > 0) {
      throw new Error(
        "drizzle.__drizzle_migrations is not empty / does not match baseline — refusing to stamp. " +
          "Fresh DBs should use migrate:up; already-stamped DBs with a matching row need no action.",
      );
    }
  }

  await assertLegacyReadyForStamp(client);
  await assertCatalogMatchesBaseline(client);

  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Use the journal's exact `when` — NOT Date.now() (drizzle-orm#5769).
  await client.query(
    `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
    [hash, when],
  );

  console.log(
    `Stamped baseline ${entry.tag} (when=${when}, hash=${hash.slice(0, 12)}…) without re-running DDL.`,
  );
}

/** @param {import('pg').Client} client */
async function assertCatalogMatchesBaseline(client) {
  const actual = await captureCatalog(client);
  const diffs = diffAgainstExpected(actual);
  if (diffs.length > 0) {
    throw new Error(
      formatCatalogDiffs(diffs, "stamp refused: database catalog does not match expected baseline"),
    );
  }
}

/** @param {import('pg').Client} client */
async function assertLegacyReadyForStamp(client) {
  const tableCheck = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'pgmigrations'`,
  );
  if (tableCheck.rows.length === 0) {
    throw new Error(
      "stamp requires an existing legacy DB (public.pgmigrations missing). " +
        "Fresh databases should run migrate:up (Drizzle baseline only).",
    );
  }

  const { rows: applied } = await client.query(`SELECT name FROM pgmigrations ORDER BY name`);
  const names = applied.map((r) => r.name);
  const missing = LEGACY_EXPECTED_MIGRATIONS.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `Legacy DB is not at expected head. Missing pgmigrations: ${missing.join(", ")}`,
    );
  }

  const { rows: forceRows } = await client.query(
    `
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    ORDER BY c.relname
    `,
    [OWNED_TABLES],
  );
  if (forceRows.length > 0) {
    throw new Error(
      `Owned tables missing ENABLE+FORCE RLS: ${forceRows.map((r) => r.relname).join(", ")}`,
    );
  }

  const { rows: owned } = await client.query(
    `
    SELECT count(*)::int AS n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'owner_id'
    `,
  );
  if ((owned[0]?.n ?? 0) < OWNED_TABLES.length) {
    throw new Error(
      `Expected at least ${OWNED_TABLES.length} owner_id tables; found ${owned[0]?.n ?? 0}`,
    );
  }

  for (const fn of [
    "current_owner_id",
    "lookup_device_for_auth",
    "lookup_pairing_code",
    "lookup_user_identity",
    "lookup_session",
    "lookup_user_by_email",
    "users_set_owner_id",
  ]) {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = $1`,
      [fn],
    );
    if (rows.length === 0) {
      throw new Error(`Missing required function app.${fn}`);
    }
  }
}

/**
 * Refuse migrate:up when the DB still looks like an unstamped legacy install
 * (public.pgmigrations present, Drizzle journal empty) — avoids opaque
 * `Failed query: CREATE SCHEMA "app"` errors.
 * @param {import('pg').Client} client
 */
async function assertNotLegacyNeedingStamp(client) {
  const pgm = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'pgmigrations'`,
  );
  if (pgm.rows.length === 0) return;

  const drizzle = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
  );
  let journalEmpty = true;
  if (drizzle.rows.length > 0) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    journalEmpty = (rows[0]?.n ?? 0) === 0;
  }
  if (journalEmpty) {
    throw new Error("legacy DB detected: run migrate:stamp");
  }
}

function bootstrapPgBoss() {
  return new Promise((resolve, reject) => {
    const boot = spawn("node", ["scripts/bootstrap-pgboss.mjs"], {
      cwd: backendRoot,
      stdio: "inherit",
      env: process.env,
    });
    boot.on("exit", (bootCode, bootSignal) => {
      if (bootSignal) {
        reject(new Error(`pg-boss bootstrap killed by ${bootSignal}`));
        return;
      }
      if (bootCode !== 0) {
        reject(new Error(`pg-boss bootstrap exited ${bootCode ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

/** @param {import('pg').Client} client */
async function appRoleExistsOn(client) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'sms_app'`,
  );
  return rows.length > 0;
}

/** @param {import('pg').Client} client @param {string} password */
async function setAppRolePasswordOn(client, password) {
  await client.query("BEGIN");
  try {
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
  }
}

void main();
