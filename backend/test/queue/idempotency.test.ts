import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { withOwner } from "../../src/adapters/db-postgres/with-owner.js";
import {
  claimProcessed,
  ensureQueues,
  messageCreatedDedupeKey,
  registerOwnerHandler,
  startBoss,
  type MessageCreatedEvent,
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

describe.skipIf(!migratorOk || !appOk)("idempotent queue handlers", () => {
  let admin: Pool;
  let app: Pool;
  let boss: PgBoss;
  let ownerId: string;
  let deviceId: string;
  let messageId: string;

  beforeAll(async () => {
    admin = createAdminPool();
    await resetSchema(admin);
    await runMigrations("up");
    const seeded = await seedTwoOwners(admin);
    ownerId = seeded.ownerA;
    deviceId = seeded.deviceA;
    messageId = seeded.messageA;
    app = createAppPool();
    boss = await startBoss({
      connectionString: appDatabaseUrl(),
      installSchema: false,
      applicationName: "test-idempotency",
      supervise: false,
      test: { __test__enableSpies: true },
    });
    await ensureQueues(boss, { retryLimit: 0 });
  }, 180_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("processing the same logical job twice has one effect", async () => {
    let effects = 0;
    const log = createLogger("silent");

    await registerOwnerHandler<MessageCreatedEvent>(
      boss,
      "message.created",
      async ({ client, event, job }) => {
        const { claimed } = await claimProcessed(client, {
          ownerId: event.owner_id,
          dedupeKey: messageCreatedDedupeKey(event.message_id),
          jobName: event.type,
          jobId: job.id,
        });
        if (!claimed) {
          return;
        }
        effects += 1;
        await client.query(
          `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, message_count)
           VALUES ($1, 'device', $2, 'queue.idempotency.test', 1)`,
          [event.owner_id, event.device_id],
        );
      },
      {
        pool: app,
        log,
        pollingIntervalSeconds: 0.5,
      },
    );

    const payload = {
      type: "message.created" as const,
      owner_id: ownerId,
      message_id: messageId,
      device_id: deviceId,
    };

    const id1 = await boss.send("message.created", payload);
    const id2 = await boss.send("message.created", payload);
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    const spy = boss.getSpy("message.created");
    await spy.waitForJobWithId(id1!, "completed");
    await spy.waitForJobWithId(id2!, "completed");

    expect(effects).toBe(1);

    const rows = await withOwner(app, ownerId, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
         WHERE action = 'queue.idempotency.test'`,
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(rows).toBe(1);
  }, 60_000);
});
