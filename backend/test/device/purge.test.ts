import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { purgeExpiredReplays } from "../../src/device/replay-cache.js";
import { purgeStaleRateLimitBuckets } from "../../src/device/rate-limit.js";
import {
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
if (!migratorOk && process.env.CI === "true") {
  throw new Error(`Postgres migrator unreachable at ${migrateDatabaseUrl()}`);
}

describe.skipIf(!migratorOk)("opportunistic table purge", () => {
  let admin: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    appPool = createAppPool();
  }, 120_000);

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("purgeExpiredReplays deletes only expired replay rows", async () => {
    await appPool.query(`DELETE FROM app.device_replay_cache`);
    await appPool.query(
      `INSERT INTO app.device_replay_cache (identity, kind, value_hash, expires_at) VALUES
         ('id-a', 'nonce', 'hash-live', now() + interval '5 minutes'),
         ('id-b', 'nonce', 'hash-dead', now() - interval '1 minute'),
         ('id-c', 'signature', 'hash-dead-2', now() - interval '1 hour')`,
    );

    const deleted = await purgeExpiredReplays(appPool);
    expect(deleted).toBe(2);

    const { rows } = await appPool.query<{ value_hash: string }>(
      `SELECT value_hash FROM app.device_replay_cache ORDER BY value_hash`,
    );
    expect(rows.map((r) => r.value_hash)).toEqual(["hash-live"]);
  });

  it("purgeStaleRateLimitBuckets deletes stale unlocked windows only", async () => {
    await appPool.query(`DELETE FROM app.rate_limit_buckets`);
    await appPool.query(
      `INSERT INTO app.rate_limit_buckets (bucket_key, window_start, hit_count, locked_until) VALUES
         ('pair:ip:fresh', now() - interval '10 seconds', 1, NULL),
         ('pair:ip:stale', now() - interval '2 hours', 3, NULL),
         ('pair:invalid-ip:locked', now() - interval '2 hours', 20, now() + interval '5 minutes')`,
    );

    const deleted = await purgeStaleRateLimitBuckets(appPool, 3600);
    expect(deleted).toBe(1);

    const { rows } = await appPool.query<{ bucket_key: string }>(
      `SELECT bucket_key FROM app.rate_limit_buckets ORDER BY bucket_key`,
    );
    expect(rows.map((r) => r.bucket_key)).toEqual(["pair:invalid-ip:locked", "pair:ip:fresh"]);
  });
});
