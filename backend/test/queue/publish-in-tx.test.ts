import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { ensureQueues, publishInTx, startBoss } from "../../src/queue/index.js";
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
if ((!migratorOk || !appOk) && process.env.CI === "true") {
  throw new Error("Postgres unreachable for publishInTx tests");
}

describe.skipIf(!migratorOk || !appOk)("publishInTx transactional publish", () => {
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
      applicationName: "test-publish",
      supervise: false,
      test: { __test__enableSpies: true },
    });
    await ensureQueues(boss);
  }, 180_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await app?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("does not leave a job visible when the transaction rolls back", async () => {
    const client = await app.connect();
    const mid = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
      const jobId = await publishInTx(boss, client, {
        type: "message.created",
        owner_id: ownerId,
        message_id: mid,
        device_id: deviceId,
      });
      expect(jobId).toBeTruthy();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const found = await boss.findJobs("message.created", { data: { message_id: mid } });
    expect(found).toHaveLength(0);
  });

  it("makes the job visible after the transaction commits", async () => {
    const client = await app.connect();
    let jobId: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
      jobId = await publishInTx(boss, client, {
        type: "message.created",
        owner_id: ownerId,
        message_id: messageId,
        device_id: deviceId,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    expect(jobId).toBeTruthy();
    const found = await boss.findJobs("message.created", { id: jobId! });
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toMatchObject({
      type: "message.created",
      owner_id: ownerId,
      message_id: messageId,
      device_id: deviceId,
    });
    expect(found[0]?.data).not.toHaveProperty("body");
    expect(found[0]?.data).not.toHaveProperty("sender");
  });
});
