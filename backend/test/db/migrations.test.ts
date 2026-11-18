import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  canConnect,
  createAdminPool,
  listOwnedTables,
  migrateDatabaseUrl,
  resetSchema,
  runLegacyMigrations,
  runMigrations,
} from "../helpers/pg.js";
import { OWNED_TABLE_FORCE_RLS_FLOOR } from "../../src/adapters/db-postgres/schema.js";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

describe.skipIf(!migratorOk)("Drizzle migrations", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
  });

  it("applies baseline on a fresh DB and leaves FORCE RLS on owned tables", async () => {
    await resetSchema(admin);

    await runMigrations("up");
    await runMigrations("up"); // idempotent no-op when already at head

    const tables = await listOwnedTables(admin);
    expect(tables.length).toBeGreaterThanOrEqual(OWNED_TABLE_FORCE_RLS_FLOOR);
    expect(tables).toContain("sessions");
    expect(tables).toContain("queue_processed_jobs");

    const pgboss = await admin.query<{ n: string }>(
      `SELECT nspname AS n FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(pgboss.rows).toHaveLength(1);

    const { rows } = await admin.query<{ missing_force: number }>(`
      SELECT count(*)::int AS missing_force
      FROM information_schema.columns c
      JOIN pg_class cls ON cls.relname = c.table_name
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
      WHERE c.table_schema = 'public'
        AND c.column_name = 'owner_id'
        AND cls.relkind = 'r'
        AND (NOT cls.relrowsecurity OR NOT cls.relforcerowsecurity)
    `);
    expect(rows[0]?.missing_force).toBe(0);
  }, 180_000);

  it("refuses migrate down (Drizzle has no down)", async () => {
    await expect(
      execFileAsync("node", ["scripts/migrate.mjs", "down"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: migrateDatabaseUrl(),
          SMS_APP_PASSWORD: "sms_app",
        },
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/no down/i),
    });
  });

  it("detects legacy DB on migrate:up and hints migrate:stamp", async () => {
    await resetSchema(admin);
    await runLegacyMigrations("up");

    await expect(
      execFileAsync("node", ["scripts/migrate.mjs", "up"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: migrateDatabaseUrl(),
          SMS_APP_PASSWORD: "sms_app",
        },
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/legacy DB detected: run migrate:stamp/i),
    });
  }, 180_000);
});

describe.skipIf(!migratorOk)("baseline stamp (legacy → Drizzle)", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
  });

  it("stamps without re-running DDL and preserves journal when for later migrations", async () => {
    await resetSchema(admin);
    await runLegacyMigrations("up");

    const beforeTables = await listOwnedTables(admin);
    expect(beforeTables.length).toBeGreaterThanOrEqual(OWNED_TABLE_FORCE_RLS_FLOOR);

    const beforeCols = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );

    await runMigrations("stamp");

    const { rows: journal } = await admin.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    expect(journal).toHaveLength(1);

    const journalFile = JSON.parse(
      fs.readFileSync(path.join(backendRoot, "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number; tag: string }> };
    expect(journalFile.entries[0]?.tag).toBe("0000_baseline");
    expect(Number(journal[0]?.created_at)).toBe(journalFile.entries[0]!.when);

    const afterCols = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(afterCols.rows[0]?.n).toBe(beforeCols.rows[0]?.n);

    // Probe a later migration on a TEMP copy of drizzle/ — never rewrite tracked journal.
    const tmpDrizzle = fs.mkdtempSync(path.join(os.tmpdir(), "sms-drizzle-probe-"));
    fs.cpSync(path.join(backendRoot, "drizzle"), tmpDrizzle, { recursive: true });
    const laterWhen = journalFile.entries[0]!.when + 1_000;
    const laterTag = "0001_stamp_probe";
    fs.writeFileSync(
      path.join(tmpDrizzle, `${laterTag}.sql`),
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS stamp_probe_col text;`,
    );
    const tmpJournalPath = path.join(tmpDrizzle, "meta/_journal.json");
    const tmpJournal = JSON.parse(fs.readFileSync(tmpJournalPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    tmpJournal.entries.push({
      idx: 1,
      version: "7",
      when: laterWhen,
      tag: laterTag,
      breakpoints: true,
    });
    fs.writeFileSync(tmpJournalPath, JSON.stringify(tmpJournal, null, 2) + "\n");

    try {
      await execFileAsync("node", ["scripts/migrate.mjs", "up"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: migrateDatabaseUrl(),
          SMS_APP_PASSWORD: "sms_app",
          DRIZZLE_MIGRATIONS_FOLDER: tmpDrizzle,
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      const probe = await admin.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'stamp_probe_col'`,
      );
      expect(probe.rows).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDrizzle, { recursive: true, force: true });
      await admin
        .query(`ALTER TABLE users DROP COLUMN IF EXISTS stamp_probe_col`)
        .catch(() => undefined);
    }
  }, 180_000);

  it("refuses to stamp a fresh (non-legacy) database", async () => {
    await resetSchema(admin);
    await expect(runMigrations("stamp")).rejects.toThrow(/legacy|pgmigrations/i);
  }, 60_000);
});

describe("drizzle journal + push guards", () => {
  it("journal when values strictly increase", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(backendRoot, "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number }> };
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
  });

  it("package.json has no drizzle-kit push script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, value] of Object.entries(pkg.scripts)) {
      expect(name, name).not.toMatch(/\bpush\b/i);
      expect(value, `${name}=${value}`).not.toMatch(/drizzle-kit\s+push/);
    }
  });
});
