import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { InfrastructureError } from "../../src/domain/errors.js";
import {
  PgDeviceAuthRepository,
  PgIdentityRepository,
  PgIngestRateLimiter,
  PgMessageRepository,
  PgPairingCodeRepository,
  PgPairRateLimiter,
  PgReplayCache,
  PgSessionRepository,
  PgStreamRepository,
  PgUserRepository,
  DEFAULT_RATE_LIMIT_CONFIG,
} from "../../src/adapters/db-postgres/index.js";
import { DEFAULT_INGEST_CONFIG } from "../../src/adapters/ingest/index.js";
import { PgBossQueuePublisher } from "../../src/adapters/queue-pgboss/pg-queue-publisher.js";
import {
  MemoryDeviceAuthRepository,
  MemoryIdentityRepository,
  MemoryPairingCodeRepository,
  MemoryIngestRateLimiter,
  MemoryMessageRepository,
  MemoryPairRateLimiter,
  MemoryQueuePublisher,
  MemoryReplayCache,
  MemorySessionRepository,
  MemoryStreamRepository,
  MemoryUserRepository,
} from "../application/fakes/memory-ports.js";
import {
  canConnect,
  createAdminPool,
  createAppPool,
  migrateDatabaseUrl,
  resetSchema,
  runMigrations,
} from "../helpers/pg.js";

const migratorOk = await canConnect(migrateDatabaseUrl());

const OWNER = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

describe("outbound port contracts (null = not found; infra throws InfrastructureError)", () => {
  describe("in-memory fakes — every method", () => {
    it("SessionRepository: each method throws InfrastructureError when fault is set", async () => {
      const sessions = new MemorySessionRepository();
      await expect(sessions.lookupBySessionIdHash("missing")).resolves.toBeNull();

      sessions.fault.throwInfra = true;
      await expect(
        sessions.insert({
          ownerId: OWNER,
          sessionIdHash: HASH,
          csrfTokenHash: HASH,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(sessions.lookupBySessionIdHash(HASH)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(sessions.revokeBySessionIdHash(OWNER, HASH)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(sessions.touch(OWNER, "row-1")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("IdentityRepository: each method throws InfrastructureError when fault is set", async () => {
      const identities = new MemoryIdentityRepository();
      await expect(identities.findByIssuerSub("iss", "sub")).resolves.toBeNull();

      identities.fault.throwInfra = true;
      await expect(identities.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(identities.link(OWNER, "iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("UserRepository: each method throws InfrastructureError when fault is set", async () => {
      const users = new MemoryUserRepository();
      await expect(users.findById(OWNER, OWNER)).resolves.toBeNull();

      users.fault.throwInfra = true;
      await expect(users.findById(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(users.findByEmail("a@b.c")).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.create({
          ownerId: OWNER,
          email: "a@b.c",
          mfaEnrolled: false,
          lastAuthMethod: null,
          displayName: null,
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.updateAuthProfile({
          ownerId: OWNER,
          mfaEnrolled: true,
          lastAuthMethod: "otp",
          displayName: "A",
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        users.linkIdentityAndUpdate({
          ownerId: OWNER,
          issuer: "iss",
          sub: "sub",
          mfaEnrolled: true,
          lastAuthMethod: "otp",
          displayName: "A",
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("DeviceAuthRepository: each method throws InfrastructureError when fault is set", async () => {
      const devices = new MemoryDeviceAuthRepository();
      await expect(devices.lookupForAuth(OWNER)).resolves.toBeNull();

      devices.fault.throwInfra = true;
      await expect(devices.lookupForAuth(OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        devices.pairWithBurnedCode({
          ownerId: OWNER,
          pairingCodeId: "pc",
          displayName: "Phone",
          publicKey: "pk",
          deviceInfo: { platform: "android", app_version: "1" },
          clientIp: "127.0.0.1",
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(devices.findMe(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(devices.revoke(OWNER, OWNER, "127.0.0.1")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("PairingCodeRepository: each method throws InfrastructureError when fault is set", async () => {
      const codes = new MemoryPairingCodeRepository();
      await expect(codes.lookupByHash(HASH)).resolves.toBeNull();

      codes.fault.throwInfra = true;
      await expect(codes.lookupByHash(HASH)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        codes.insert({ ownerId: OWNER, codeHash: HASH, ttlSeconds: 300 }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(codes.burn(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("ReplayCache + PairRateLimiter + QueuePublisher: fault → InfrastructureError", async () => {
      const replay = new MemoryReplayCache();
      await expect(replay.claimNonceAndSignature("id", "n", "s")).resolves.toBe("ok");
      replay.fault.throwInfra = true;
      await expect(replay.claimNonceAndSignature("id", "n", "s")).rejects.toBeInstanceOf(
        InfrastructureError,
      );

      const rl = new MemoryPairRateLimiter();
      rl.fault.throwInfra = true;
      await expect(rl.checkIpAllowed("1.1.1.1")).rejects.toBeInstanceOf(InfrastructureError);
      await expect(rl.checkGlobalInvalidAllowed()).rejects.toBeInstanceOf(InfrastructureError);
      await expect(rl.noteInvalidCode("1.1.1.1")).rejects.toBeInstanceOf(InfrastructureError);

      const q = new MemoryQueuePublisher();
      q.fault.throwInfra = true;
      await expect(
        q.publishInTx(null, { type: "message.created", owner_id: OWNER }),
      ).rejects.toBeInstanceOf(InfrastructureError);

      const msgs = new MemoryMessageRepository();
      msgs.fault.throwInfra = true;
      await expect(
        msgs.upsertBatch({
          ownerId: OWNER,
          deviceId: OWNER,
          messages: [
            {
              deviceMsgId: "x",
              sender: "+1",
              bodyCiphertext: new Uint8Array([1]),
              receivedAt: new Date(),
              simSlot: null,
              direction: "inbound",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);

      const ingestRl = new MemoryIngestRateLimiter();
      ingestRl.fault.throwInfra = true;
      await expect(ingestRl.checkRequestAllowed(OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(ingestRl.checkMessageVolumeAllowed(OWNER, 1)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("StreamRepository: null/false on miss; every method → InfrastructureError on fault", async () => {
      const streams = new MemoryStreamRepository();
      await expect(streams.findById(OWNER, OWNER)).resolves.toBeNull();
      await expect(streams.delete(OWNER, OWNER)).resolves.toBe(false);

      streams.fault.throwInfra = true;
      await expect(
        streams.insert({
          ownerId: OWNER,
          name: "A",
          mode: "rules",
          rulesJson: [],
          aiPrompt: null,
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(streams.list(OWNER, 10)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(streams.findById(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        streams.update({ ownerId: OWNER, streamId: OWNER, patch: { name: "B" } }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(streams.delete(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
    });
  });

  describe.skipIf(!migratorOk)("Postgres adapters — every method + exploding pool", () => {
    let admin: Pool;
    let appPool: Pool;
    let exploding: Pool;

    beforeAll(async () => {
      admin = createAdminPool();
      await resetSchema(admin);
      await runMigrations("up");
      // Seed owner so withOwner RLS paths can run against a live pool for null-miss cases.
      await admin.query(
        `INSERT INTO users (id, owner_id, email) VALUES ($1, $1, 'contract@example.com')
         ON CONFLICT DO NOTHING`,
        [OWNER],
      );
      appPool = createAppPool();
      exploding = {
        query: async () => {
          throw new Error("simulated postgres outage");
        },
        connect: async () => {
          throw new Error("simulated postgres outage");
        },
        end: async () => undefined,
      } as unknown as Pool;
    }, 120_000);

    afterAll(async () => {
      await appPool?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
    });

    it("PgSessionRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgSessionRepository(appPool);
      await expect(ok.lookupBySessionIdHash(HASH)).resolves.toBeNull();

      const broken = new PgSessionRepository(exploding);
      const cases: Array<[string, () => Promise<unknown>]> = [
        [
          "insert",
          () =>
            broken.insert({
              ownerId: OWNER,
              sessionIdHash: HASH,
              csrfTokenHash: HASH,
              expiresAt: new Date(Date.now() + 60_000),
            }),
        ],
        ["lookupBySessionIdHash", () => broken.lookupBySessionIdHash(HASH)],
        ["revokeBySessionIdHash", () => broken.revokeBySessionIdHash(OWNER, HASH)],
        ["touch", () => broken.touch(OWNER, OWNER)],
      ];
      for (const [name, fn] of cases) {
        await expect(fn(), name).rejects.toBeInstanceOf(InfrastructureError);
      }
    });

    it("PgIdentityRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgIdentityRepository(appPool);
      await expect(ok.findByIssuerSub("https://idp", "nobody")).resolves.toBeNull();

      const broken = new PgIdentityRepository(exploding);
      await expect(broken.findByIssuerSub("iss", "sub")).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      await expect(broken.link(OWNER, "iss", "sub")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgUserRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgUserRepository(appPool);
      await expect(ok.findByEmail("nobody@example.com")).resolves.toBeNull();

      const broken = new PgUserRepository(exploding);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["findById", () => broken.findById(OWNER, OWNER)],
        ["findByEmail", () => broken.findByEmail("x@y.z")],
        [
          "create",
          () =>
            broken.create({
              ownerId: OWNER,
              email: "x@y.z",
              mfaEnrolled: false,
              lastAuthMethod: null,
              displayName: null,
            }),
        ],
        [
          "updateAuthProfile",
          () =>
            broken.updateAuthProfile({
              ownerId: OWNER,
              mfaEnrolled: true,
              lastAuthMethod: "otp",
              displayName: "A",
            }),
        ],
        [
          "linkIdentityAndUpdate",
          () =>
            broken.linkIdentityAndUpdate({
              ownerId: OWNER,
              issuer: "iss",
              sub: "sub",
              mfaEnrolled: true,
              lastAuthMethod: "otp",
              displayName: "A",
            }),
        ],
      ];
      for (const [name, fn] of cases) {
        await expect(fn(), name).rejects.toBeInstanceOf(InfrastructureError);
      }
    });

    it("PgDeviceAuthRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgDeviceAuthRepository(appPool);
      await expect(ok.lookupForAuth(OWNER)).resolves.toBeNull();

      const broken = new PgDeviceAuthRepository(exploding);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["lookupForAuth", () => broken.lookupForAuth(OWNER)],
        [
          "pairWithBurnedCode",
          () =>
            broken.pairWithBurnedCode({
              ownerId: OWNER,
              pairingCodeId: OWNER,
              displayName: "Phone",
              publicKey: "pk",
              deviceInfo: { platform: "android", app_version: "1" },
              clientIp: "127.0.0.1",
            }),
        ],
        ["findMe", () => broken.findMe(OWNER, OWNER)],
        ["revoke", () => broken.revoke(OWNER, OWNER, "127.0.0.1")],
      ];
      for (const [name, fn] of cases) {
        await expect(fn(), name).rejects.toBeInstanceOf(InfrastructureError);
      }
    });

    it("PgPairingCodeRepository: null on miss; every method → InfrastructureError on fault", async () => {
      const ok = new PgPairingCodeRepository(appPool);
      await expect(ok.lookupByHash(HASH)).resolves.toBeNull();

      const broken = new PgPairingCodeRepository(exploding);
      await expect(broken.lookupByHash(HASH)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        broken.insert({ ownerId: OWNER, codeHash: HASH, ttlSeconds: 300 }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(broken.burn(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgReplayCache + PgPairRateLimiter: every method → InfrastructureError on fault", async () => {
      const replay = new PgReplayCache(exploding);
      await expect(replay.claimNonceAndSignature("id", "nonce", "sig")).rejects.toBeInstanceOf(
        InfrastructureError,
      );

      const rl = new PgPairRateLimiter(exploding, DEFAULT_RATE_LIMIT_CONFIG);
      await expect(rl.checkIpAllowed("127.0.0.1")).rejects.toBeInstanceOf(InfrastructureError);
      await expect(rl.checkGlobalInvalidAllowed()).rejects.toBeInstanceOf(InfrastructureError);
      await expect(rl.noteInvalidCode("127.0.0.1")).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgBossQueuePublisher: publish failure → InfrastructureError", async () => {
      const boss = {
        send: async () => {
          throw new Error("simulated pg-boss outage");
        },
      };
      const publisher = new PgBossQueuePublisher(boss as never);
      await expect(
        publisher.publishInTx(
          { query: async () => ({ rows: [] }) },
          {
            type: "message.created",
            owner_id: OWNER,
            message_id: OWNER,
            device_id: OWNER,
          },
        ),
      ).rejects.toBeInstanceOf(InfrastructureError);
    });

    it("PgMessageRepository + PgIngestRateLimiter: every method → InfrastructureError on fault", async () => {
      const queue = new PgBossQueuePublisher({
        send: async () => "job",
      } as never);
      const brokenMsgs = new PgMessageRepository(exploding, queue);
      await expect(
        brokenMsgs.upsertBatch({
          ownerId: OWNER,
          deviceId: OWNER,
          messages: [
            {
              deviceMsgId: "x",
              sender: "+15551234567",
              bodyCiphertext: new Uint8Array([1]),
              receivedAt: new Date(),
              simSlot: null,
              direction: "inbound",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);

      const brokenRl = new PgIngestRateLimiter(exploding, DEFAULT_INGEST_CONFIG);
      await expect(brokenRl.checkRequestAllowed(OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(brokenRl.checkMessageVolumeAllowed(OWNER, 1)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
    });

    it("PgStreamRepository: null/false on miss; every method → InfrastructureError on fault", async () => {
      const queue = new MemoryQueuePublisher();
      const ok = new PgStreamRepository(appPool, queue);
      await expect(ok.findById(OWNER, OWNER)).resolves.toBeNull();
      await expect(ok.delete(OWNER, OWNER)).resolves.toBe(false);

      const broken = new PgStreamRepository(exploding, queue);
      await expect(
        broken.insert({
          ownerId: OWNER,
          name: "A",
          mode: "rules",
          rulesJson: [],
          aiPrompt: null,
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(broken.list(OWNER, 10)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(broken.findById(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
      await expect(
        broken.update({ ownerId: OWNER, streamId: OWNER, patch: { name: "B" } }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      await expect(broken.delete(OWNER, OWNER)).rejects.toBeInstanceOf(InfrastructureError);
    });
  });
});
