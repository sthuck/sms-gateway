import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Job, PgBoss } from "pg-boss";
import { ensureQueues, startBoss } from "../../src/queue/index.js";
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
const appOk = await canConnect(appDatabaseUrl());

describe.skipIf(!migratorOk || !appOk)("concurrent consumers (SKIP LOCKED)", () => {
  let admin: Pool;
  let app: Pool;
  let publishers: PgBoss;
  let ownerId: string;
  let deviceId: string;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    const seeded = await seedTwoOwners(admin);
    ownerId = seeded.ownerA;
    deviceId = seeded.deviceA;
    app = createAppPool();
    publishers = await startBoss({
      connectionString: appDatabaseUrl(),
      installSchema: false,
      applicationName: "test-concurrent-pub",
      supervise: false,
    });
    await ensureQueues(publishers, { retryLimit: 0 });
  }, 180_000);

  afterAll(async () => {
    await publishers?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("handles each job exactly once across 3 consumers", async () => {
    const handled = new Map<string, number>();
    const jobCount = 30;
    const workers: PgBoss[] = [];

    try {
      for (let i = 0; i < 3; i += 1) {
        const worker = await startBoss({
          connectionString: appDatabaseUrl(),
          installSchema: false,
          applicationName: `test-concurrent-w${i}`,
          supervise: false,
          test: { __test__enableSpies: true },
        });
        workers.push(worker);
        await worker.work(
          "message.created",
          { pollingIntervalSeconds: 0.5, localConcurrency: 2 },
          async (jobs: Job<{ message_id: string }>[]) => {
            const job = jobs[0]!;
            const mid = job.data.message_id;
            handled.set(mid, (handled.get(mid) ?? 0) + 1);
            // Small delay so other workers compete for remaining jobs.
            await new Promise((r) => setTimeout(r, 5));
          },
        );
      }

      const ids: string[] = [];
      for (let i = 0; i < jobCount; i += 1) {
        const messageId = randomUUID();
        ids.push(messageId);
        const jobId = await publishers.send("message.created", {
          type: "message.created",
          owner_id: ownerId,
          message_id: messageId,
          device_id: deviceId,
        });
        expect(jobId).toBeTruthy();
      }

      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (handled.size === jobCount && [...handled.values()].every((n) => n === 1)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(handled.size).toBe(jobCount);
      for (const id of ids) {
        expect(handled.get(id)).toBe(1);
      }
    } finally {
      await Promise.all(
        workers.map((w) => w.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined)),
      );
    }
  }, 90_000);
});
