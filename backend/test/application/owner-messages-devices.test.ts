import { describe, expect, it } from "vitest";
import { IdentityBodyCodec } from "../../src/adapters/body-codec/index.js";
import { AesGcmBodyCodec, DekCache } from "../../src/adapters/body-codec/index.js";
import { MemoryKeyWrapper } from "../../src/adapters/key-wrapper/index.js";
import {
  DeleteMessage,
  GetMessage,
  ListDevices,
  ListMessages,
  RenameDevice,
  RevokeDevice,
} from "../../src/application/use-cases/index.js";
import { DeviceError } from "../../src/domain/device/errors.js";
import { MessageError } from "../../src/domain/message/errors.js";
import {
  MemoryDeviceAuthRepository,
  MemoryMessageRepository,
  MemoryUserKeyRepository,
} from "./fakes/memory-ports.js";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b1";
const DEVICE = "00000000-0000-4000-8000-0000000000d1";

const identity = new IdentityBodyCodec();

function aesCodec() {
  return new AesGcmBodyCodec({
    keyWrapper: new MemoryKeyWrapper(),
    userKeys: new MemoryUserKeyRepository(),
    cache: new DekCache({ ttlMs: 300_000, maxEntries: 100 }),
  });
}

describe("ListMessages use case", () => {
  it("paginates with opaque cursor without duplicates or gaps", async () => {
    const messages = new MemoryMessageRepository();
    for (let i = 0; i < 5; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      messages.seed({
        id,
        ownerId: OWNER,
        deviceId: DEVICE,
        deviceMsgId: `msg-${i}`,
        sender: `+1${i}`,
        bodyCiphertext: await identity.encode(
          { ownerId: OWNER, deviceId: DEVICE, deviceMsgId: `msg-${i}` },
          `body-${i}`,
        ),
        receivedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, i)),
        simSlot: 0,
        direction: "inbound",
      });
    }

    const list = new ListMessages({ messages, bodyCodec: identity });
    const page1 = await list.execute({ ownerId: OWNER, limit: 2 });
    expect(page1.messages.map((m) => m.body)).toEqual(["body-4", "body-3"]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await list.execute({
      ownerId: OWNER,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.body)).toEqual(["body-2", "body-1"]);

    const page3 = await list.execute({
      ownerId: OWNER,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.body)).toEqual(["body-0"]);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("searches decrypted content and ignores ciphertext", async () => {
    const codec = aesCodec();
    const messages = new MemoryMessageRepository();
    const bodies = ["OTP bank 123", "hello world", "bank OTP again"];
    for (let i = 0; i < bodies.length; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      const deviceMsgId = `enc-${i}`;
      messages.seed({
        id,
        ownerId: OWNER,
        deviceId: DEVICE,
        deviceMsgId,
        sender: "+1555",
        bodyCiphertext: await codec.encode(
          { ownerId: OWNER, deviceId: DEVICE, deviceMsgId },
          bodies[i]!,
        ),
        receivedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, i)),
        simSlot: 0,
        direction: "inbound",
      });
    }

    const list = new ListMessages({ messages, bodyCodec: codec });
    const result = await list.execute({ ownerId: OWNER, q: "otp", limit: 10 });
    expect(result.messages.map((m) => m.body).sort()).toEqual(["OTP bank 123", "bank OTP again"]);
    for (const row of messages.rows.values()) {
      expect(Buffer.from(row.message.bodyCiphertext).includes(Buffer.from("OTP"))).toBe(false);
    }
  });

  it("round-trips empty body", async () => {
    const codec = aesCodec();
    const messages = new MemoryMessageRepository();
    const id = "00000000-0000-4000-8000-000000000001";
    messages.seed({
      id,
      ownerId: OWNER,
      deviceId: DEVICE,
      deviceMsgId: "empty",
      sender: "+1",
      bodyCiphertext: await codec.encode(
        { ownerId: OWNER, deviceId: DEVICE, deviceMsgId: "empty" },
        "",
      ),
      receivedAt: new Date(Date.UTC(2026, 0, 1)),
      simSlot: null,
      direction: "inbound",
    });

    const get = new GetMessage({ messages, bodyCodec: codec });
    const message = await get.execute({ ownerId: OWNER, messageId: id });
    expect(message.body).toBe("");
  });

  it("returns not_found for other owner's message", async () => {
    const messages = new MemoryMessageRepository();
    const id = "00000000-0000-4000-8000-000000000001";
    messages.seed({
      id,
      ownerId: OWNER,
      deviceId: DEVICE,
      deviceMsgId: "x",
      sender: "+1",
      bodyCiphertext: await identity.encode(
        { ownerId: OWNER, deviceId: DEVICE, deviceMsgId: "x" },
        "secret",
      ),
      receivedAt: new Date(),
      simSlot: 0,
      direction: "inbound",
    });

    const get = new GetMessage({ messages, bodyCodec: identity });
    await expect(get.execute({ ownerId: OTHER, messageId: id })).rejects.toBeInstanceOf(
      MessageError,
    );

    const del = new DeleteMessage({ messages });
    await expect(del.execute({ ownerId: OTHER, messageId: id })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await messages.findById(OWNER, id)).not.toBeNull();
  });
});

describe("ListDevices / RenameDevice", () => {
  it("lists and renames owner devices; other owner gets not_found", async () => {
    const devices = new MemoryDeviceAuthRepository();
    devices.seed({
      deviceId: DEVICE,
      ownerId: OWNER,
      status: "active",
      publicKey: "pk",
      credentialRevokedAt: null,
      name: "Pixel",
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      lastSeenAt: null,
    });

    const list = new ListDevices({ devices });
    const listed = await list.execute({ ownerId: OWNER });
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]?.name).toBe("Pixel");

    const rename = new RenameDevice({ devices });
    const updated = await rename.execute({ ownerId: OWNER, deviceId: DEVICE, name: "Kitchen" });
    expect(updated.name).toBe("Kitchen");

    await expect(
      rename.execute({ ownerId: OTHER, deviceId: DEVICE, name: "Stolen" }),
    ).rejects.toBeInstanceOf(DeviceError);

    const revoke = new RevokeDevice({ devices });
    await expect(
      revoke.execute({ ownerId: OTHER, deviceId: DEVICE, clientIp: "127.0.0.1" }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
