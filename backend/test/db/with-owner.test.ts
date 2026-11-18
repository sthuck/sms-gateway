import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withOwner } from "../../src/db/with-owner.js";
import {
  appDatabaseUrl,
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
  seedTwoOwners,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

describe.skipIf(!migratorOk)("withOwner helper", () => {
  let admin: Pool;
  let app: Pool;
  let ownerA: string;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    if (!(await canConnect(appDatabaseUrl()))) {
      throw new Error(`Cannot connect as sms_app at ${appDatabaseUrl()}`);
    }
    app = createAppPool();
    const seed = await seedTwoOwners(admin);
    ownerA = seed.ownerA;
  }, 120_000);

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("sets app.owner_id transaction-locally", async () => {
    await withOwner(app, ownerA, async (client) => {
      const { rows } = await client.query<{ v: string | null }>(
        `SELECT current_setting('app.owner_id', true) AS v`,
      );
      expect(rows[0]?.v).toBe(ownerA);
    });

    // After the transaction, a fresh checkout must not see the setting.
    const client = await app.connect();
    try {
      const { rows } = await client.query<{ v: string | null }>(
        `SELECT nullif(current_setting('app.owner_id', true), '') AS v`,
      );
      expect(rows[0]?.v).toBeNull();
    } finally {
      client.release();
    }
  });

  it("rolls back and rethrows when fn fails", async () => {
    await expect(
      withOwner(app, ownerA, async (client) => {
        await client.query(
          `INSERT INTO sender_ai_optout (owner_id, sender_pattern)
           VALUES ($1, 'temp-pattern')`,
          [ownerA],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await withOwner(app, ownerA, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM sender_ai_optout WHERE sender_pattern = 'temp-pattern'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("rejects empty ownerId", async () => {
    await expect(withOwner(app, "", async () => undefined)).rejects.toThrow(/non-empty/);
  });
});
