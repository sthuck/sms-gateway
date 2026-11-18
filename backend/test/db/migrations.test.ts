import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  canConnect,
  createAdminPool,
  listOwnedTables,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(backendRoot, "migrations");
const sth12Fixture = path.join(backendRoot, "test/fixtures/1795001000000_queue-processed-jobs.cjs");
const sth12Live = path.join(migrationsDir, "1795001000000_queue-processed-jobs.cjs");

describe.skipIf(!migratorOk)("migrations up/down/up", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await unlink(sth12Live).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("runs up, down, up cleanly and leaves RLS-forced owned tables", async () => {
    await resetSchema(admin);

    await runMigrations("up");
    let tables = await listOwnedTables(admin);
    expect(tables).toContain("messages");
    expect(tables).toContain("user_identities");

    const afterUp = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(Number(afterUp.rows[0]?.count)).toBeGreaterThan(0);

    // Drain every applied migration (count varies as stacked PRs land).
    for (let i = 0; i < 20; i++) {
      const { rows } = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgmigrations`,
      );
      if (Number(rows[0]?.count ?? 0) === 0) break;
      await runMigrations("down");
    }

    tables = await listOwnedTables(admin);
    expect(tables).toHaveLength(0);

    await runMigrations("up");
    await runMigrations("up"); // idempotent no-op when already at head

    tables = await listOwnedTables(admin);
    expect(tables.length).toBeGreaterThanOrEqual(13);
    expect(tables).toContain("sessions");

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

  it("coexists with STH-12 queue migration ID (STH-40 / #5)", async () => {
    // Simulate merge with #5: both migration files present, either order of merge.
    await copyFile(sth12Fixture, sth12Live);
    try {
      await resetSchema(admin);
      await runMigrations("up");

      const { rows } = await admin.query<{ name: string }>(
        `SELECT name FROM pgmigrations ORDER BY name`,
      );
      const names = rows.map((r) => r.name);
      expect(names).toContain("1795001000000_queue-processed-jobs");
      expect(names).toContain("1795002000000_device-auth-support");
      expect(names.indexOf("1795001000000_queue-processed-jobs")).toBeLessThan(
        names.indexOf("1795002000000_device-auth-support"),
      );

      // Simulate DB that already ran #5 first, then pulls #6: remaining up is fine.
      for (let i = 0; i < 20; i++) {
        const { rows: left } = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pgmigrations`,
        );
        if (Number(left[0]?.count ?? 0) === 0) break;
        await runMigrations("down");
      }
      await runMigrations("up");
      const again = await admin.query<{ name: string }>(
        `SELECT name FROM pgmigrations ORDER BY name`,
      );
      expect(again.rows.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "1795001000000_queue-processed-jobs",
          "1795002000000_device-auth-support",
        ]),
      );
    } finally {
      await unlink(sth12Live).catch(() => undefined);
    }
  }, 180_000);
});
