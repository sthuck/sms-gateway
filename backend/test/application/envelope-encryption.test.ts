import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AesGcmBodyCodec, DekCache } from "../../src/adapters/body-codec/index.js";
import { MemoryKeyWrapper } from "../../src/adapters/key-wrapper/index.js";
import {
  DeleteUserData,
  IngestMessageBatch,
  reencryptMessagesForOwner,
  rotateDekForOwner,
  rotateKekForOwner,
} from "../../src/application/use-cases/index.js";
import { DecryptionError, InfrastructureError } from "../../src/domain/errors.js";
import { formatPhoneSender } from "../../src/adapters/phone/index.js";
import {
  MemoryMessageRepository,
  MemoryUserKeyRepository,
  MemoryUserRepository,
  MemoryIngestRateLimiter,
} from "./fakes/memory-ports.js";

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000b1";
const DEVICE_A = "00000000-0000-4000-8000-0000000000a2";
const DEVICE_B = "00000000-0000-4000-8000-0000000000b2";
const MARKER = "PLAINTEXT_MARKER_STH20_UNIQUE_xyzzy";

function buildCodec(opts?: {
  wrapper?: MemoryKeyWrapper;
  userKeys?: MemoryUserKeyRepository;
  cache?: DekCache;
  now?: () => number;
}) {
  const wrapper = opts?.wrapper ?? new MemoryKeyWrapper();
  const userKeys = opts?.userKeys ?? new MemoryUserKeyRepository();
  const cache =
    opts?.cache ??
    (opts?.now
      ? new DekCache({ ttlMs: 300_000, maxEntries: 100, now: opts.now })
      : new DekCache({ ttlMs: 300_000, maxEntries: 100 }));
  const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
  return { codec, wrapper, userKeys, cache };
}

describe("envelope encryption (STH-20)", () => {
  it("round-trips plaintext with per-user DEKs", async () => {
    const { codec } = buildCodec();
    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "m1" };
    const blob = await codec.encode(ctx, "hello otp 123456");
    expect(Buffer.from(blob).includes(Buffer.from("hello otp"))).toBe(false);
    expect(await codec.decode(ctx, blob)).toBe("hello otp 123456");
  });

  it("user A's DEK cannot decrypt user B's ciphertext (and AAD swap fails)", async () => {
    const sharedKeys = new MemoryUserKeyRepository();
    const { codec } = buildCodec({ userKeys: sharedKeys });
    const ctxA = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "a1" };
    const ctxB = { ownerId: OWNER_B, deviceId: DEVICE_B, deviceMsgId: "b1" };
    const blobA = await codec.encode(ctxA, "secret-a");
    const blobB = await codec.encode(ctxB, "secret-b");

    await expect(codec.decode(ctxB, blobA)).rejects.toBeInstanceOf(DecryptionError);
    await expect(codec.decode(ctxA, blobB)).rejects.toBeInstanceOf(DecryptionError);
    // Same bytes, wrong AAD (moved to another row/owner).
    await expect(
      codec.decode({ ownerId: OWNER_B, deviceId: DEVICE_A, deviceMsgId: "a1" }, blobA),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("tampered blob fails as DecryptionError", async () => {
    const { codec } = buildCodec();
    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "t1" };
    const blob = Buffer.from(await codec.encode(ctx, "tamper-me"));
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff;
    await expect(codec.decode(ctx, blob)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("KEK outage on encode is InfrastructureError (fail closed)", async () => {
    const wrapper = new MemoryKeyWrapper();
    const { codec } = buildCodec({ wrapper });
    wrapper.unavailable = true;
    await expect(
      codec.encode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "x" }, "nope"),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("KEK outage on decode is InfrastructureError", async () => {
    const wrapper = new MemoryKeyWrapper();
    const { codec, cache } = buildCodec({ wrapper });
    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "x" };
    const blob = await codec.encode(ctx, "stored");
    cache.clear();
    wrapper.unavailable = true;
    await expect(codec.decode(ctx, blob)).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("DEK cache TTL expires entries", async () => {
    let now = 1_000_000;
    const cache = new DekCache({ ttlMs: 1_000, maxEntries: 10, now: () => now });
    const wrapper = new MemoryKeyWrapper();
    const userKeys = new MemoryUserKeyRepository();
    const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "c1" };
    const blob = await codec.encode(ctx, "cached");
    expect(cache.size).toBe(1);

    const unwrapSpy = vi.spyOn(wrapper, "unwrap");
    expect(await codec.decode(ctx, blob)).toBe("cached");
    expect(unwrapSpy).not.toHaveBeenCalled();

    now += 2_000;
    unwrapSpy.mockClear();
    expect(await codec.decode(ctx, blob)).toBe("cached");
    expect(unwrapSpy).toHaveBeenCalled();
    expect(userKeys.rows.size).toBe(1);
  });

  it("concurrent first-use creates exactly one DEK and both succeed", async () => {
    const userKeys = new MemoryUserKeyRepository();
    const wrapper = new MemoryKeyWrapper();
    const cache = new DekCache({ ttlMs: 60_000, maxEntries: 10 });

    // Serialize create material generation through a shared gate so both
    // callers race the insert path like Postgres ON CONFLICT.
    let creates = 0;
    const original = userKeys.getOrCreateLatest.bind(userKeys);
    userKeys.getOrCreateLatest = async (ownerId, create) => {
      creates += 1;
      return original(ownerId, create);
    };

    const codecA = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
    const codecB = new AesGcmBodyCodec({
      keyWrapper: wrapper,
      userKeys,
      cache: new DekCache({ ttlMs: 60_000, maxEntries: 10 }),
    });

    const [b1, b2] = await Promise.all([
      codecA.encode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "r1" }, "one"),
      codecB.encode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "r2" }, "two"),
    ]);

    expect(userKeys.rows.size).toBe(1);
    expect(
      await codecA.decode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "r1" }, b1),
    ).toBe("one");
    expect(
      await codecB.decode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "r2" }, b2),
    ).toBe("two");
    expect(creates).toBeGreaterThanOrEqual(1);
  });

  it("KEK rotation re-wraps DEKs; rows still decrypt after old KEK is dropped", async () => {
    const wrapper = new MemoryKeyWrapper({ activeKekId: "kek-old" });
    const userKeys = new MemoryUserKeyRepository();
    const cache = new DekCache({ ttlMs: 60_000, maxEntries: 10 });
    const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "rot1" };
    const blob = await codec.encode(ctx, "keep-me");
    const before = [...userKeys.rows.values()][0]!;
    expect(before.kekId).toBe("kek-old");

    // Keep kek-old in the map for unwrap; activate kek-new for wrap.
    wrapper.rotateActive("kek-new", randomBytes(32));

    const result = await rotateKekForOwner(OWNER_A, {
      userKeys,
      keyWrapper: wrapper,
      invalidateCache: (id) => cache.invalidate(id),
    });
    expect(result.rewrapped).toBe(1);
    expect(result.kekId).toBe("kek-new");
    expect([...userKeys.rows.values()][0]!.kekId).toBe("kek-new");

    wrapper.dropKek("kek-old");
    expect(await codec.decode(ctx, blob)).toBe("keep-me");
  });

  it("DEK rotation + re-encrypt moves rows to the new version", async () => {
    const wrapper = new MemoryKeyWrapper();
    const userKeys = new MemoryUserKeyRepository();
    const messages = new MemoryMessageRepository();
    const cache = new DekCache({ ttlMs: 60_000, maxEntries: 10 });
    const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });

    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "d1" };
    const blobV1 = await codec.encode(ctx, "version-one-body");
    await messages.upsertBatch({
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      messages: [
        {
          deviceMsgId: "d1",
          sender: "+15551234567",
          bodyCiphertext: blobV1,
          receivedAt: new Date(),
          simSlot: 0,
          direction: "inbound",
        },
      ],
    });

    const { dekVersion } = await rotateDekForOwner(OWNER_A, {
      userKeys,
      keyWrapper: wrapper,
      messages,
      bodyCodec: codec,
      generateDek: () => randomBytes(32),
      cacheDek: (o, v, d) => cache.set(o, v, d),
    });
    expect(dekVersion).toBe(2);
    expect(userKeys.rows.size).toBe(2);

    // Old ciphertext still decrypts via dek_version in the blob.
    expect(await codec.decode(ctx, blobV1)).toBe("version-one-body");

    const re = await reencryptMessagesForOwner(
      OWNER_A,
      {
        userKeys,
        keyWrapper: wrapper,
        messages,
        bodyCodec: codec,
        generateDek: () => randomBytes(32),
      },
      { batchSize: 10 },
    );
    expect(re.updated).toBe(1);
    expect(re.done).toBe(true);

    const stored = [...messages.rows.values()][0]!.message.bodyCiphertext;
    expect(Buffer.from(stored)[0]).toBe(1);
    // dek_version uint16 BE at bytes 1..2 should be 2.
    expect(Buffer.from(stored).readUInt16BE(1)).toBe(2);
    expect(await codec.decode(ctx, stored)).toBe("version-one-body");
  });

  it("crypto-shred deletes DEKs so leftover ciphertext is undecryptable", async () => {
    const wrapper = new MemoryKeyWrapper();
    const userKeys = new MemoryUserKeyRepository();
    const users = new MemoryUserRepository();
    const cache = new DekCache({ ttlMs: 60_000, maxEntries: 10 });
    const codec = new AesGcmBodyCodec({ keyWrapper: wrapper, userKeys, cache });
    await users.create({
      ownerId: OWNER_A,
      email: "a@example.com",
      mfaEnrolled: false,
      lastAuthMethod: null,
      displayName: null,
    });

    const ctx = { ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "shred1" };
    const leftover = await codec.encode(ctx, "still-in-backup");
    expect(userKeys.rows.size).toBe(1);

    const shred = new DeleteUserData({
      userKeys,
      users,
      invalidateCache: (id) => cache.invalidate(id),
    });
    const result = await shred.execute(OWNER_A);
    expect(result.keysDeleted).toBe(1);
    expect(result.userDeleted).toBe(true);
    expect(userKeys.rows.size).toBe(0);

    await expect(codec.decode(ctx, leftover)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("ingest stores no plaintext marker in body_ciphertext bytes", async () => {
    const { codec } = buildCodec();
    const messages = new MemoryMessageRepository();
    const useCase = new IngestMessageBatch({
      messages,
      rateLimiter: new MemoryIngestRateLimiter(),
      bodyCodec: codec,
      formatPhone: formatPhoneSender,
      defaultPhoneRegion: "US",
    });

    const result = await useCase.execute({
      ownerId: OWNER_A,
      deviceId: DEVICE_A,
      rawMessages: [
        {
          device_msg_id: "ingest-1",
          sender: "+15551234567",
          body: MARKER,
          received_at: "2026-11-18T09:45:12Z",
          sim_slot: 0,
          direction: "inbound",
        },
      ],
      now: new Date("2026-11-18T12:00:00Z"),
    });
    expect(result.ok).toBe(true);

    const stored = [...messages.rows.values()][0]!.message.bodyCiphertext;
    const raw = Buffer.from(stored);
    expect(raw.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
    expect(
      await codec.decode({ ownerId: OWNER_A, deviceId: DEVICE_A, deviceMsgId: "ingest-1" }, stored),
    ).toBe(MARKER);
  });

  it("KEK outage during ingest propagates InfrastructureError (retryable 5xx path)", async () => {
    const wrapper = new MemoryKeyWrapper();
    const { codec } = buildCodec({ wrapper });
    wrapper.unavailable = true;
    const messages = new MemoryMessageRepository();
    const useCase = new IngestMessageBatch({
      messages,
      rateLimiter: new MemoryIngestRateLimiter(),
      bodyCodec: codec,
      formatPhone: formatPhoneSender,
      defaultPhoneRegion: "US",
    });

    await expect(
      useCase.execute({
        ownerId: OWNER_A,
        deviceId: DEVICE_A,
        rawMessages: [
          {
            device_msg_id: "fail-1",
            sender: "+15551234567",
            body: "should-not-store",
            received_at: "2026-11-18T09:45:12Z",
            direction: "inbound",
          },
        ],
        now: new Date("2026-11-18T12:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(messages.rows.size).toBe(0);
  });
});
