import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe.skipIf(!migratorOk)("migrations up/down/up", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
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
    expect(tables.length).toBeGreaterThanOrEqual(14);
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

  it("keeps STH-12 queue migration before STH-14 device-auth (STH-40)", async () => {
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
  }, 180_000);
});
