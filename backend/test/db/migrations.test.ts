import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
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
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const execFileAsync = promisify(execFile);
    const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

    // Simulate a later migration with when > stamped created_at; it must still apply.
    const laterWhen = journalFile.entries[0]!.when + 1_000;
    const laterTag = "0001_stamp_probe";
    const laterSql = `ALTER TABLE users ADD COLUMN IF NOT EXISTS stamp_probe_col text;`;
    const drizzleDir = path.join(backendRoot, "drizzle");
    const laterPath = path.join(drizzleDir, `${laterTag}.sql`);
    const journalPath = path.join(drizzleDir, "meta/_journal.json");
    const journalOriginal = fs.readFileSync(journalPath, "utf8");
    fs.writeFileSync(laterPath, laterSql);
    const journalObj = JSON.parse(journalOriginal) as {
      entries: Array<Record<string, unknown>>;
    };
    journalObj.entries.push({
      idx: 1,
      version: "7",
      when: laterWhen,
      tag: laterTag,
      breakpoints: true,
    });
    fs.writeFileSync(journalPath, JSON.stringify(journalObj, null, 2) + "\n");

    try {
      await runMigrations("up");
      const probe = await admin.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'stamp_probe_col'`,
      );
      expect(probe.rows).toHaveLength(1);
    } finally {
      fs.unlinkSync(laterPath);
      fs.writeFileSync(journalPath, journalOriginal);
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
