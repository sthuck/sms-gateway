import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  canConnect,
  createAdminPool,
  migrateDatabaseUrl,
  resetSchema,
  runLegacyMigrations,
  runMigrations,
} from "../helpers/pg.js";
import {
  captureCatalog,
  diffAgainstExpected,
  diffCatalogs,
  formatCatalogDiffs,
} from "../../scripts/catalog-fingerprint.mjs";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

type Mutator = { name: string; sql: string; expectMatch: RegExp };

/** Mutations the dump-only check historically missed — catalog diff must catch each. */
const CATALOG_MUTATIONS: Mutator[] = [
  {
    name: "extra grant to sms_app on messages (TRIGGER)",
    sql: `GRANT TRIGGER ON TABLE messages TO sms_app`,
    expectMatch: /messages|TRIGGER|acl/i,
  },
  {
    name: "PUBLIC table grant on messages",
    sql: `GRANT SELECT ON TABLE messages TO PUBLIC`,
    expectMatch: /messages|PUBLIC|acl/i,
  },
  {
    name: "PUBLIC EXECUTE on SECURITY DEFINER function",
    sql: `GRANT EXECUTE ON FUNCTION app.lookup_session(text) TO PUBLIC`,
    expectMatch: /lookup_session|PUBLIC|EXECUTE|acl/i,
  },
  {
    name: "ALTER DEFAULT PRIVILEGES (extra PUBLIC table grant)",
    sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC`,
    expectMatch: /defaultAcls|PUBLIC|SELECT/i,
  },
  {
    name: "ALTER ROLE sms_app BYPASSRLS",
    sql: `ALTER ROLE sms_app BYPASSRLS`,
    expectMatch: /rolbypassrls|sms_app|roles/i,
  },
];

describe.skipIf(!migratorOk)("catalog fingerprint catches privilege/role drift", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
  });

  it("baseline catalog matches expected-catalog.json", async () => {
    await resetSchema(admin);
    await runMigrations("up");
    const client = await admin.connect();
    try {
      const catalog = await captureCatalog(client);
      const diffs = diffAgainstExpected(catalog);
      expect(diffs, formatCatalogDiffs(diffs)).toEqual([]);
    } finally {
      client.release();
    }
  }, 180_000);

  for (const mut of CATALOG_MUTATIONS) {
    it(`detects: ${mut.name}`, async () => {
      await resetSchema(admin);
      await runMigrations("up");
      const client = await admin.connect();
      try {
        const before = await captureCatalog(client);
        await client.query(mut.sql);
        const after = await captureCatalog(client);
        const diffs = diffCatalogs(before, after, {
          leftLabel: "before",
          rightLabel: "mutated",
        });
        expect(diffs.length, `expected diffs for ${mut.name}`).toBeGreaterThan(0);
        expect(formatCatalogDiffs(diffs)).toMatch(mut.expectMatch);
      } finally {
        // Best-effort undo so later tests / shared role state stay clean.
        await client.query(`ALTER ROLE sms_app NOBYPASSRLS`).catch(() => undefined);
        client.release();
      }
    }, 180_000);
  }
});

describe.skipIf(!migratorOk)("stamp refuses catalog drift", () => {
  let admin: Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
  });

  const STAMP_MUTATIONS: Mutator[] = [
    {
      name: "dropped policy",
      sql: `DROP POLICY owner_isolation ON messages`,
      expectMatch: /polic|owner_isolation|messages/i,
    },
    {
      name: "ALL granted to PUBLIC on messages",
      sql: `GRANT ALL ON TABLE messages TO PUBLIC`,
      expectMatch: /messages|PUBLIC|acl/i,
    },
    {
      name: "reset function search_path",
      sql: `ALTER FUNCTION app.lookup_session(text) RESET search_path`,
      expectMatch: /lookup_session|search_path|config|proconfig|functions/i,
    },
  ];

  for (const mut of STAMP_MUTATIONS) {
    it(`refuses stamp when: ${mut.name}`, async () => {
      await resetSchema(admin);
      await runLegacyMigrations("up");
      await admin.query(mut.sql);
      await expect(runMigrations("stamp")).rejects.toThrow(mut.expectMatch);
    }, 180_000);
  }

  it("stamp is idempotent when already stamped", async () => {
    await resetSchema(admin);
    await runLegacyMigrations("up");
    await runMigrations("stamp");
    await runMigrations("stamp");
  }, 180_000);
});
