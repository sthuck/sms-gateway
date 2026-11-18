#!/usr/bin/env node
/**
 * CI: prove (legacy migrations up + stamp) ≡ (empty DB + Drizzle baseline).
 *
 * Creates two temporary databases, applies each path, dumps schema-only
 * (excluding pgboss + drizzle), normalizes, and diffs. Exit 1 on mismatch.
 *
 * Requires a privileged MIGRATE_DATABASE_URL that can CREATE DATABASE.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adminUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("Set MIGRATE_DATABASE_URL for schema-equivalence.");
  process.exit(1);
}
if (!process.env.SMS_APP_PASSWORD) {
  process.env.SMS_APP_PASSWORD = "sms_app";
}

const suffix = `${process.pid}_${Date.now()}`;
const legacyDb = `sms_eq_legacy_${suffix}`;
const drizzleDb = `sms_eq_drizzle_${suffix}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sms-schema-eq-"));

function dbUrl(name) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.href;
}

function run(cmd, args, env = {}) {
  execFileSync(cmd, args, {
    cwd: backendRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function dumpNormalized(database, outFile) {
  const raw = execFileSync(
    "pg_dump",
    [
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--exclude-schema=pgboss",
      "--exclude-schema=drizzle",
      database,
    ],
    {
      env: {
        ...process.env,
        PGHOST: new URL(adminUrl).hostname || "127.0.0.1",
        PGPORT: new URL(adminUrl).port || "5432",
        PGUSER: decodeURIComponent(new URL(adminUrl).username || "sms"),
        PGPASSWORD: decodeURIComponent(new URL(adminUrl).password || ""),
      },
      encoding: "utf8",
    },
  );
  const normalized = execFileSync("node", ["scripts/schema-dump-normalize.mjs"], {
    cwd: backendRoot,
    input: raw,
    encoding: "utf8",
  });
  fs.writeFileSync(outFile, normalized);
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${legacyDb}`);
    await admin.query(`DROP DATABASE IF EXISTS ${drizzleDb}`);
    await admin.query(`CREATE DATABASE ${legacyDb}`);
    await admin.query(`CREATE DATABASE ${drizzleDb}`);
  } finally {
    await admin.end();
  }

  try {
    console.log("→ legacy migrations up + stamp");
    run("node", ["scripts/legacy-migrate.mjs", "up"], {
      MIGRATE_DATABASE_URL: dbUrl(legacyDb),
      DATABASE_URL: dbUrl(legacyDb),
    });
    // Ensure sms_app password exists for bootstrap (role may be new on empty cluster)
    const legacyAdmin = new pg.Client({ connectionString: dbUrl(legacyDb) });
    await legacyAdmin.connect();
    try {
      await legacyAdmin.query("BEGIN");
      await legacyAdmin.query("SELECT set_config('sms.eq_password', $1, true)", [
        process.env.SMS_APP_PASSWORD,
      ]);
      await legacyAdmin.query(`
        DO $pwd$
        BEGIN
          EXECUTE format(
            'ALTER ROLE sms_app PASSWORD %L',
            current_setting('sms.eq_password', true)
          );
        END
        $pwd$;
      `);
      await legacyAdmin.query("COMMIT");
    } catch (err) {
      await legacyAdmin.query("ROLLBACK").catch(() => undefined);
      // Role may already have a password; continue.
      console.warn("note: could not set sms_app password:", err.message);
    } finally {
      await legacyAdmin.end();
    }

    run("node", ["scripts/migrate.mjs", "stamp"], {
      MIGRATE_DATABASE_URL: dbUrl(legacyDb),
      DATABASE_URL: dbUrl(legacyDb),
      SMS_APP_PASSWORD: process.env.SMS_APP_PASSWORD,
    });

    console.log("→ drizzle baseline up");
    run("node", ["scripts/migrate.mjs", "up"], {
      MIGRATE_DATABASE_URL: dbUrl(drizzleDb),
      DATABASE_URL: dbUrl(drizzleDb),
      SMS_APP_PASSWORD: process.env.SMS_APP_PASSWORD,
    });

    const legacyDump = path.join(tmp, "legacy.dump");
    const drizzleDump = path.join(tmp, "drizzle.dump");
    dumpNormalized(legacyDb, legacyDump);
    dumpNormalized(drizzleDb, drizzleDump);

    try {
      execFileSync("diff", ["-u", legacyDump, drizzleDump], { stdio: "inherit" });
      console.log("Schema equivalence OK.");
    } catch {
      console.error("Schema dumps differ (legacy+stamp vs drizzle baseline).");
      process.exitCode = 1;
    }
  } finally {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${legacyDb}`);
      await cleanup.query(`DROP DATABASE IF EXISTS ${drizzleDb}`);
    } finally {
      await cleanup.end();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
