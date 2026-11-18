import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  deadLetterQueueName,
  ensureQueues,
  JOB_DEAD_LETTERED,
  QueueMetrics,
  registerDeadLetterObserver,
  startBoss,
} from "../../src/queue/index.js";
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
import { createLogger } from "../../src/logger.js";

const migratorOk = await canConnect(migrateDatabaseUrl());
const appOk = await canConnect(appDatabaseUrl());

describe.skipIf(!migratorOk || !appOk)("retries and dead-letter queue", () => {
  let admin: Pool;
  let app: Pool;
  let boss: PgBoss;
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

    boss = await startBoss({
      connectionString: appDatabaseUrl(),
      installSchema: false,
      applicationName: "test-dlq",
      supervise: true,
      test: { __test__enableSpies: true },
    });
    // Immediate retries (no backoff) so the test does not need TestClock /
    // CREATE on schema pgboss.
    await ensureQueues(boss, {
      retryLimit: 2,
      retryDelay: 0,
      retryBackoff: false,
    });
  }, 180_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 10_000 }).catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("retries a failing handler then lands in the DLQ", async () => {
    const metrics = new QueueMetrics();
    const log = createLogger("silent");
    const queue = "message.created";
    const dlq = deadLetterQueueName("message.created");
    let attempts = 0;

    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => {
      attempts += 1;
      throw new Error("always fail");
    });
    await registerDeadLetterObserver(boss, dlq, {
      log,
      metrics,
      pollingIntervalSeconds: 0.5,
    });

    const messageId = randomUUID();
    const jobId = await boss.send(queue, {
      type: "message.created",
      owner_id: ownerId,
      message_id: messageId,
      device_id: deviceId,
    });
    expect(jobId).toBeTruthy();

    // retryLimit=2 → initial try + 2 retries = 3 attempts, then DLQ.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const dlqJobs = await boss.findJobs(dlq, {
        data: { message_id: messageId },
        limit: 10,
      });
      if (
        dlqJobs.length > 0 &&
        attempts >= 3 &&
        metrics.get(JOB_DEAD_LETTERED, { queue: dlq }) >= 1
      ) {
        break;
      }
      await boss.supervise(queue);
      await boss.supervise(dlq);
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(attempts).toBeGreaterThanOrEqual(3);
    const dlqJobs = await boss.findJobs(dlq, {
      data: { message_id: messageId },
      limit: 10,
    });
    expect(dlqJobs.length).toBeGreaterThanOrEqual(1);
    expect(metrics.get(JOB_DEAD_LETTERED, { queue: dlq })).toBeGreaterThanOrEqual(1);

    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain(JOB_DEAD_LETTERED);
    expect(rendered).toContain(dlq);
  }, 60_000);
});
