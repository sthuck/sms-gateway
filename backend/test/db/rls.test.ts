import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withOwner } from "../../src/db/with-owner.js";
import {
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  createAppPool,
  listOwnedTables,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
  seedTwoOwners,
  type SeededOwners,
} from "../helpers/pg.js";

// sms_app may not exist until migrations run; check migrator first.
const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

describe.skipIf(!migratorOk)("RLS owner isolation", () => {
  let admin: Pool;
  let app: Pool;
  let ownedTables: string[];
  let seed: SeededOwners;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");

    // App role is created by the migration; ensure we can connect.
    if (!(await canConnect(appDatabaseUrl()))) {
      throw new Error(
        `Cannot connect as sms_app (${appDatabaseUrl()}). Check SMS_APP_PASSWORD / role.`,
      );
    }
    app = createAppPool();
    ownedTables = await listOwnedTables(admin);
    seed = await seedTwoOwners(admin);
  }, 120_000);

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("discovers owned tables from the catalog (owner_id column)", () => {
    expect(ownedTables.length).toBeGreaterThanOrEqual(12);
    expect(ownedTables).toEqual(
      expect.arrayContaining([
        "users",
        "user_identities",
        "devices",
        "device_credentials",
        "pairing_codes",
        "messages",
        "streams",
        "stream_membership",
        "agent_clients",
        "agent_grants",
        "audit_log",
        "sender_ai_optout",
        "queue_processed_jobs",
      ]),
    );
  });

  it("enables and forces RLS on every owned table", async () => {
    const { rows } = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
      `,
      [ownedTables],
    );

    expect(rows).toHaveLength(ownedTables.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it("with owner A set, queries never return owner B rows (all owned tables)", async () => {
    await withOwner(app, seed.ownerA, async (client) => {
      for (const table of ownedTables) {
        const { rows } = await client.query<{ owner_id: string }>(
          `SELECT owner_id FROM ${quoteIdent(table)}`,
        );
        expect(rows.length, `${table} should return at least one row for A`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.owner_id, `${table} leaked owner B`).toBe(seed.ownerA);
          expect(row.owner_id).not.toBe(seed.ownerB);
        }
      }
    });
  });

  it("query without app.owner_id returns zero rows on every owned table", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      // Explicitly clear any leftover setting on this connection.
      await client.query("SELECT set_config('app.owner_id', '', true)");
      for (const table of ownedTables) {
        const { rows } = await client.query(`SELECT 1 FROM ${quoteIdent(table)} LIMIT 1`);
        expect(rows, `${table} visible without owner`).toHaveLength(0);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("inserts with mismatched owner_id are rejected by WITH CHECK", async () => {
    await withOwner(app, seed.ownerA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO devices (owner_id, name, status)
           VALUES ($1, 'evil', 'active')`,
          [seed.ownerB],
        ),
      ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege (RLS WITH CHECK)
    });
  });

  it("sms_app cannot bypass RLS", async () => {
    const { rows } = await app.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `);
    expect(rows[0]?.rolname).toBe("sms_app");
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("lookup_device_for_auth resolves owner without app.owner_id", async () => {
    const client = await app.connect();
    try {
      await client.query("SELECT set_config('app.owner_id', '', true)");
      const { rows } = await client.query<{
        device_id: string;
        owner_id: string;
        public_key: string;
      }>(`SELECT * FROM app.lookup_device_for_auth($1)`, [seed.deviceA]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.owner_id).toBe(seed.ownerA);
      expect(rows[0]?.public_key).toBe("pk-a");
    } finally {
      client.release();
    }
  });

  it("lookup_pairing_code resolves owner without app.owner_id", async () => {
    const client = await app.connect();
    try {
      await client.query("SELECT set_config('app.owner_id', '', true)");
      const { rows } = await client.query<{ owner_id: string }>(
        `SELECT * FROM app.lookup_pairing_code($1)`,
        ["hash-a"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.owner_id).toBe(seed.ownerA);
    } finally {
      client.release();
    }
  });
});

function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ident)) {
    throw new Error(`Refusing to quote unsafe identifier: ${ident}`);
  }
  return `"${ident}"`;
}
