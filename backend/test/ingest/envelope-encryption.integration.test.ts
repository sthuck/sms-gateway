import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { AesGcmBodyCodec, DekCache } from "../../src/adapters/body-codec/index.js";
import { MemoryKeyWrapper } from "../../src/adapters/key-wrapper/index.js";
import {
  PgMessageRepository,
  PgUserKeyRepository,
  withOwner,
} from "../../src/adapters/db-postgres/index.js";
import { IngestMessageBatch } from "../../src/application/use-cases/index.js";
import { InfrastructureError } from "../../src/domain/errors.js";
import { formatPhoneSender } from "../../src/adapters/phone/index.js";
import { createAdminPool, createAppPool, resetSchema, runMigrations } from "../helpers/pg.js";
import {
  MemoryIngestRateLimiter,
  MemoryQueuePublisher,
} from "../application/fakes/memory-ports.js";

const MARKER = "PLAINTEXT_MARKER_STH20_DB_RAW_xyzzy";

const migratorOk = Boolean(process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? true);

describe.skipIf(!migratorOk)("envelope encryption integration (STH-20)", () => {
  let admin: Pool;
  let app: Pool;
  let ownerId: string;
  let deviceId: string;

  beforeAll(async () => {
    admin = createAdminPool();
    app = createAppPool();
    await resetSchema(admin);
    await runMigrations("up");
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE TABLE
        queue_processed_jobs, stream_membership, messages, user_keys,
        streams, sessions, audit_log, agent_grants, agent_clients,
        sender_ai_optout, device_credentials, pairing_codes, devices,
        user_identities, users
      RESTART IDENTITY CASCADE
    `);

    const user = await admin.query<{ id: string }>(
      `INSERT INTO users (email, mfa_enrolled) VALUES ('enc@example.com', true) RETURNING id`,
    );
    ownerId = user.rows[0]!.id;
    await admin.query(`UPDATE users SET owner_id = id WHERE id = $1`, [ownerId]);
    const device = await admin.query<{ id: string }>(
      `INSERT INTO devices (owner_id, name, status) VALUES ($1, 'enc-phone', 'active') RETURNING id`,
      [ownerId],
    );
    deviceId = device.rows[0]!.id;
  });

  function buildStack(wrapper: MemoryKeyWrapper = new MemoryKeyWrapper()) {
    const userKeys = new PgUserKeyRepository(app);
    const cache = new DekCache({ ttlMs: 60_000, maxEntries: 100 });
    const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
    const queue = new MemoryQueuePublisher();
    const messages = new PgMessageRepository(app, queue);
    const ingest = new IngestMessageBatch({
      messages,
      rateLimiter: new MemoryIngestRateLimiter(),
      bodyCodec: codec,
      formatPhone: formatPhoneSender,
      defaultPhoneRegion: "US",
    });
    return { wrapper, userKeys, cache, codec, messages, ingest, queue };
  }

  it("raw body_ciphertext does not contain the plaintext marker", async () => {
    const { ingest } = buildStack();
    const result = await ingest.execute({
      ownerId,
      deviceId,
      rawMessages: [
        {
          device_msg_id: "raw-1",
          sender: "+15551234567",
          body: MARKER,
          received_at: "2026-11-18T09:45:12Z",
          direction: "inbound",
        },
      ],
      now: new Date("2026-11-18T12:00:00Z"),
    });
    expect(result.ok).toBe(true);

    const { rows } = await admin.query<{ body: Buffer }>(
      `SELECT body_ciphertext AS body FROM messages WHERE device_msg_id = 'raw-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
  });

  it("concurrent first ingests create exactly one DEK and both succeed", async () => {
    const { ingest, userKeys } = buildStack();
    const mk = (id: string) => ({
      device_msg_id: id,
      sender: "+15551234567",
      body: `body-${id}`,
      received_at: "2026-11-18T09:45:12Z",
      direction: "inbound" as const,
    });

    const [a, b] = await Promise.all([
      ingest.execute({
        ownerId,
        deviceId,
        rawMessages: [mk("race-a")],
        now: new Date("2026-11-18T12:00:00Z"),
      }),
      ingest.execute({
        ownerId,
        deviceId,
        rawMessages: [mk("race-b")],
        now: new Date("2026-11-18T12:00:00Z"),
      }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const keys = await userKeys.listForOwner(ownerId);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.dekVersion).toBe(1);

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0]!.n).toBe(2);
  });

  it("KEK outage during ingest stores nothing", async () => {
    const wrapper = new MemoryKeyWrapper();
    wrapper.unavailable = true;
    const { ingest } = buildStack(wrapper);
    await expect(
      ingest.execute({
        ownerId,
        deviceId,
        rawMessages: [
          {
            device_msg_id: "outage-1",
            sender: "+15551234567",
            body: "nope",
            received_at: "2026-11-18T09:45:12Z",
            direction: "inbound",
          },
        ],
        now: new Date("2026-11-18T12:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(InfrastructureError);

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0]!.n).toBe(0);
    await withOwner(app, ownerId, async (client) => {
      const keys = await client.query(`SELECT count(*)::int AS n FROM user_keys`);
      expect(keys.rows[0]!.n).toBe(0);
    });
  });
});
