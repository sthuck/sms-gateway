import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canConnect,
  createAdminPool,
  migrateDatabaseUrl,
  resetSchema,
  runLegacyMigrations,
  runMigrations,
} from "../helpers/pg.js";
import {
  assertMigratorOwnership,
  captureCatalog,
  diffAgainstExpected,
  diffCatalogs,
  formatCatalogDiffs,
} from "../../scripts/catalog-fingerprint.mjs";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  {
    name: "GRANT CREATE ON SCHEMA public TO PUBLIC",
    sql: `GRANT CREATE ON SCHEMA public TO PUBLIC`,
    expectMatch: /namespaces|public|CREATE|PUBLIC/i,
  },
  {
    name: "column-level GRANT SELECT (owner_id) TO PUBLIC",
    sql: `GRANT SELECT (owner_id) ON messages TO PUBLIC`,
    expectMatch: /columnAcls|messages|owner_id|PUBLIC/i,
  },
  {
    name: "role membership GRANT sms TO sms_app",
    sql: `GRANT sms TO sms_app`,
    expectMatch: /roleMembers|sms_app/i,
  },
  {
    name: "role setting ALTER ROLE sms_app SET statement_timeout",
    sql: `ALTER ROLE sms_app SET statement_timeout = '15s'`,
    expectMatch: /roleSettings|sms_app|statement_timeout/i,
  },
  {
    name: "unexpected added column",
    sql: `ALTER TABLE messages ADD COLUMN catalog_probe_col text`,
    expectMatch: /columns|catalog_probe_col|messages/i,
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
      // expected-catalog.json fingerprints the baseline (stamp target).
      // Post-baseline migrations (e.g. user_keys) appear only in the DB.
      const diffs = diffAgainstExpected(catalog).filter((d) => !/\buser_keys\b/.test(d));
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
        // Same diff primitive schema-equivalence.mjs uses between the two DBs.
        const diffs = diffCatalogs(before, after, {
          leftLabel: "before",
          rightLabel: "mutated",
        });
        expect(diffs.length, `expected diffs for ${mut.name}`).toBeGreaterThan(0);
        expect(formatCatalogDiffs(diffs)).toMatch(mut.expectMatch);
      } finally {
        await client.query(`ALTER ROLE sms_app NOBYPASSRLS`).catch(() => undefined);
        await client.query(`ALTER ROLE sms_app RESET statement_timeout`).catch(() => undefined);
        await client.query(`REVOKE sms FROM sms_app`).catch(() => undefined);
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
    {
      name: "NO FORCE RLS on messages",
      sql: `ALTER TABLE messages NO FORCE ROW LEVEL SECURITY`,
      expectMatch: /force_rls|messages|tables/i,
    },
    {
      name: "BYPASSRLS on sms_app",
      sql: `ALTER ROLE sms_app BYPASSRLS`,
      expectMatch: /rolbypassrls|sms_app|roles/i,
    },
  ];

  for (const mut of STAMP_MUTATIONS) {
    it(`refuses stamp when: ${mut.name}`, async () => {
      await resetSchema(admin);
      await runLegacyMigrations("up");
      const client = await admin.connect();
      try {
        const before = await captureCatalog(client);
        await client.query(mut.sql);
        const after = await captureCatalog(client);
        // Same catalog primitive schema-equivalence.mjs uses between the two paths.
        const catalogDiffs = diffCatalogs(before, after, {
          leftLabel: "before",
          rightLabel: "mutated",
        });
        expect(catalogDiffs.length, `expected catalog diffs for ${mut.name}`).toBeGreaterThan(0);
        expect(formatCatalogDiffs(catalogDiffs)).toMatch(mut.expectMatch);
      } finally {
        client.release();
      }
      await expect(runMigrations("stamp")).rejects.toThrow(mut.expectMatch);
      await admin.query(`ALTER ROLE sms_app NOBYPASSRLS`).catch(() => undefined);
    }, 180_000);
  }

  const OWNER_MUTATIONS: {
    name: string;
    prepare: (role: string) => string;
    expectMatch: RegExp;
  }[] = [
    {
      name: "OWNER TO other role on table messages",
      prepare: (role) => `CREATE ROLE ${role} NOLOGIN; ALTER TABLE messages OWNER TO ${role}`,
      expectMatch: /owner|messages|migrator/i,
    },
    {
      name: "OWNER TO other role on SECURITY DEFINER app.lookup_session",
      prepare: (role) =>
        `CREATE ROLE ${role} NOLOGIN; ALTER FUNCTION app.lookup_session(text) OWNER TO ${role}`,
      expectMatch: /owner|lookup_session|migrator/i,
    },
    {
      name: "OWNER TO other role on schema app",
      prepare: (role) => `CREATE ROLE ${role} NOLOGIN; ALTER SCHEMA app OWNER TO ${role}`,
      expectMatch: /owner|schema app|migrator/i,
    },
  ];

  for (const mut of OWNER_MUTATIONS) {
    it(`refuses stamp when: ${mut.name}`, async () => {
      const role = `evil_${process.pid}_${Date.now()}`.replace(/\W/g, "_").slice(0, 63);
      await resetSchema(admin);
      await runLegacyMigrations("up");
      await admin.query(mut.prepare(role));
      const client = await admin.connect();
      try {
        const ownerDiffs = await assertMigratorOwnership(client);
        expect(ownerDiffs.length, `expected ownership diffs for ${mut.name}`).toBeGreaterThan(0);
        expect(formatCatalogDiffs(ownerDiffs)).toMatch(mut.expectMatch);
        expect(formatCatalogDiffs(ownerDiffs)).toContain(role);
      } finally {
        client.release();
      }
      await expect(runMigrations("stamp")).rejects.toThrow(mut.expectMatch);
      // resetSchema drops owned objects so the role can be removed.
      await resetSchema(admin);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }, 180_000);
  }

  it("refuses stamp when database OWNER TO another role", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const evil = `evil_db_${suffix}`.slice(0, 63);
    const db = `sms_own_${suffix}`.slice(0, 63);
    const adminUrl = new URL(migrateDatabaseUrl());
    const host = adminUrl.hostname || "127.0.0.1";
    const port = adminUrl.port || "5432";
    const user = decodeURIComponent(adminUrl.username || "sms");
    const pass = decodeURIComponent(adminUrl.password || "sms");

    await admin.query(`CREATE ROLE ${evil} NOLOGIN`);
    await admin.query(`CREATE DATABASE ${db} OWNER ${user}`);
    const dbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
    try {
      await execFileAsync("node", ["scripts/legacy-migrate.mjs", "up"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: dbUrl,
          DATABASE_URL: dbUrl,
          SMS_APP_PASSWORD: "sms_app",
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      await admin.query(`ALTER DATABASE ${db} OWNER TO ${evil}`);
      await expect(
        execFileAsync("node", ["scripts/migrate.mjs", "stamp"], {
          cwd: backendRoot,
          env: {
            ...process.env,
            MIGRATE_DATABASE_URL: dbUrl,
            DATABASE_URL: dbUrl,
            SMS_APP_PASSWORD: "sms_app",
          },
          maxBuffer: 10 * 1024 * 1024,
        }),
      ).rejects.toThrow(/owner|database|migrator|evil_db/i);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${evil}`).catch(() => undefined);
    }
  }, 180_000);

  it("stamp is idempotent when already stamped", async () => {
    await resetSchema(admin);
    await runLegacyMigrations("up");
    await runMigrations("stamp");
    await runMigrations("stamp");
  }, 180_000);

  it("stamps a legacy DB owned by a different migrator role", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const role = `adm_stamp_${suffix}`.slice(0, 63);
    const db = `sms_adm_${suffix}`.slice(0, 63);
    const adminUrl = new URL(migrateDatabaseUrl());
    const host = adminUrl.hostname || "127.0.0.1";
    const port = adminUrl.port || "5432";

    await admin.query(`CREATE ROLE ${role} SUPERUSER LOGIN PASSWORD 'adm_probe'`);
    await admin.query(`CREATE DATABASE ${db} OWNER ${role}`);

    const otherUrl = `postgres://${role}:adm_probe@${host}:${port}/${db}`;
    try {
      await execFileAsync("node", ["scripts/legacy-migrate.mjs", "up"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: otherUrl,
          DATABASE_URL: otherUrl,
          SMS_APP_PASSWORD: "sms_app",
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      await execFileAsync("node", ["scripts/migrate.mjs", "stamp"], {
        cwd: backendRoot,
        env: {
          ...process.env,
          MIGRATE_DATABASE_URL: otherUrl,
          DATABASE_URL: otherUrl,
          SMS_APP_PASSWORD: "sms_app",
        },
        maxBuffer: 10 * 1024 * 1024,
      });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
  }, 180_000);
});

describe("drizzle drift check (STH-45)", () => {
  function makeProbeTree(): { tmp: string; drizzleCopy: string; schemaCopy: string } {
    // Must live under backendRoot — drizzle-kit joins out as cwd-relative.
    const tmp = fs.mkdtempSync(path.join(backendRoot, ".drift-probe-"));
    const drizzleCopy = path.join(tmp, "drizzle");
    const schemaDir = path.join(tmp, "schema");
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.cpSync(path.join(backendRoot, "drizzle"), drizzleCopy, { recursive: true });
    const schemaCopy = path.join(schemaDir, "schema.ts");
    fs.copyFileSync(path.join(backendRoot, "src/adapters/db-postgres/schema.ts"), schemaCopy);
    fs.copyFileSync(
      path.join(backendRoot, "src/adapters/db-postgres/owned-tables.json"),
      path.join(schemaDir, "owned-tables.json"),
    );
    return { tmp, drizzleCopy, schemaCopy };
  }

  async function assertDetectsDrift(
    drizzleCopy: string,
    schemaCopy: string,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "node",
        ["scripts/check-drizzle-drift.mjs", "--assert-detects-drift", drizzleCopy, schemaCopy],
        {
          cwd: backendRoot,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return { ok: true, output: `${stdout}\n${stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}` };
    }
  }

  it("passes on the real tree with explicit no-op output and no leftover artifacts", async () => {
    const beforeSql = new Set(
      fs.readdirSync(path.join(backendRoot, "drizzle")).filter((f) => f.endsWith(".sql")),
    );
    const journalBefore = fs.readFileSync(
      path.join(backendRoot, "drizzle/meta/_journal.json"),
      "utf8",
    );
    const { stdout, stderr } = await execFileAsync("node", ["scripts/check-drizzle-drift.mjs"], {
      cwd: backendRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = `${stdout}\n${stderr}`;
    expect(out).toMatch(/No schema changes, nothing to migrate/i);
    expect(out).not.toMatch(/malformed/i);
    const afterSql = fs
      .readdirSync(path.join(backendRoot, "drizzle"))
      .filter((f) => f.endsWith(".sql"));
    expect(afterSql.filter((f) => !beforeSql.has(f))).toEqual([]);
    expect(fs.readFileSync(path.join(backendRoot, "drizzle/meta/_journal.json"), "utf8")).toBe(
      journalBefore,
    );
  }, 60_000);

  it("assert-detects-drift FAILS on an unmutated copy", async () => {
    const { tmp, drizzleCopy, schemaCopy } = makeProbeTree();
    try {
      const result = await assertDetectsDrift(drizzleCopy, schemaCopy);
      expect(result.ok, result.output).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("assert-detects-drift FAILS on a copy with a broken JSON import", async () => {
    const { tmp, drizzleCopy, schemaCopy } = makeProbeTree();
    try {
      const text = fs
        .readFileSync(schemaCopy, "utf8")
        .replace("owned-tables.json", "missing-owned-tables.json");
      fs.writeFileSync(schemaCopy, text);
      const result = await assertDetectsDrift(drizzleCopy, schemaCopy);
      expect(result.ok, result.output).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("assert-detects-drift FAILS on a garbage schema", async () => {
    const { tmp, drizzleCopy, schemaCopy } = makeProbeTree();
    try {
      fs.writeFileSync(schemaCopy, "export const notADrizzleSchema = 1;\n");
      const result = await assertDetectsDrift(drizzleCopy, schemaCopy);
      expect(result.ok, result.output).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("assert-detects-drift PASSES only for a real schema mutation", async () => {
    const { tmp, drizzleCopy, schemaCopy } = makeProbeTree();
    try {
      let schemaText = fs.readFileSync(schemaCopy, "utf8");
      if (!schemaText.includes('ownerId: uuid("owner_id")')) {
        throw new Error("unexpected schema.ts shape for drift mutation");
      }
      schemaText = schemaText.replace(
        'ownerId: uuid("owner_id").notNull()',
        'ownerId: uuid("owner_id").notNull().default("00000000-0000-0000-0000-000000000000")',
      );
      fs.writeFileSync(schemaCopy, schemaText);

      const sqlBefore = new Set(
        fs.readdirSync(path.join(backendRoot, "drizzle")).filter((f) => /^\d{4}_.+\.sql$/.test(f)),
      );
      const result = await assertDetectsDrift(drizzleCopy, schemaCopy);
      expect(result.ok, result.output).toBe(true);
      // Probe must not leave new migration SQL / mutated journal in the real tree.
      const leftover = fs
        .readdirSync(path.join(backendRoot, "drizzle"))
        .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !sqlBefore.has(f));
      expect(leftover).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
