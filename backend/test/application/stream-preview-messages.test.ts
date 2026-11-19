import { describe, expect, it } from "vitest";
import { ListStreamMessages, PreviewStream } from "../../src/application/use-cases/index.js";
import { StreamError } from "../../src/domain/stream/errors.js";
import { Re2SafeRegexCompiler } from "../../src/adapters/re2/index.js";
import {
  MemoryBodyCodec,
  MemoryMessageRepository,
  MemoryStreamRepository,
} from "./fakes/memory-ports.js";

const OWNER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const regex = new Re2SafeRegexCompiler();
const codec = new MemoryBodyCodec();

function seedMessages(messages: MemoryMessageRepository, count: number, matchEvery = 10) {
  for (let i = 0; i < count; i += 1) {
    const body = i % matchEvery === 0 ? `OTP code ${i}` : `hello ${i}`;
    messages.seed({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ownerId: OWNER,
      deviceId: DEVICE,
      sender: "+1555000",
      bodyCiphertext: codec.encode(OWNER, body),
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      simSlot: 0,
      direction: "inbound",
    });
  }
}

describe("PreviewStream use case", () => {
  it("returns matches and counts for rules mode", async () => {
    const messages = new MemoryMessageRepository();
    seedMessages(messages, 20, 5);
    const preview = new PreviewStream({ messages, bodyCodec: codec, regex });
    const result = await preview.execute({
      ownerId: OWNER,
      mode: "rules",
      rulesJson: [{ type: "body_keyword", match: "any", keywords: ["OTP"] }],
      limit: 20,
    });
    expect(result.evaluated).toBe(20);
    expect(result.matched).toBe(4);
    expect(result.matches[0]?.matchedRule?.type).toBe("body_keyword");
    expect(result.aiEvaluated).toBe(false);
    expect(result.note).toBeNull();
  });

  it("notes AI not evaluated for hybrid/ai", async () => {
    const messages = new MemoryMessageRepository();
    seedMessages(messages, 5, 1);
    const preview = new PreviewStream({ messages, bodyCodec: codec, regex });
    const hybrid = await preview.execute({
      ownerId: OWNER,
      mode: "hybrid",
      rulesJson: [{ type: "body_keyword", match: "any", keywords: ["OTP"] }],
      aiPrompt: "bank otps",
      limit: 5,
    });
    expect(hybrid.note).toMatch(/AI part not evaluated/i);
    expect(hybrid.aiEvaluated).toBe(false);
    expect(hybrid.matched).toBe(5);
  });

  it("rejects invalid rules with field-pathed errors", async () => {
    const preview = new PreviewStream({
      messages: new MemoryMessageRepository(),
      bodyCodec: codec,
      regex,
    });
    await expect(
      preview.execute({
        ownerId: OWNER,
        mode: "rules",
        rulesJson: [{ type: "body_regex", pattern: "(a+)+$" }],
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      errors: [{ path: "rules_json[0].pattern" }],
    });
  });

  it("never evaluates another owner's messages", async () => {
    const messages = new MemoryMessageRepository();
    messages.seed({
      id: "00000000-0000-4000-8000-000000000099",
      ownerId: OTHER,
      deviceId: DEVICE,
      sender: "Bank",
      bodyCiphertext: codec.encode(OTHER, "OTP secret"),
      receivedAt: new Date(),
      simSlot: 0,
      direction: "inbound",
    });
    const preview = new PreviewStream({ messages, bodyCodec: codec, regex });
    const result = await preview.execute({
      ownerId: OWNER,
      mode: "rules",
      rulesJson: [{ type: "body_keyword", match: "any", keywords: ["OTP"] }],
    });
    expect(result.evaluated).toBe(0);
    expect(result.matched).toBe(0);
  });

  it("evaluates 500 messages under 1s (generous local bound)", async () => {
    const messages = new MemoryMessageRepository();
    seedMessages(messages, 500, 7);
    const preview = new PreviewStream({ messages, bodyCodec: codec, regex });
    const started = performance.now();
    const result = await preview.execute({
      ownerId: OWNER,
      mode: "rules",
      rulesJson: [
        {
          type: "or",
          rules: [
            { type: "body_keyword", match: "any", keywords: ["OTP"] },
            { type: "sender_prefix", value: "+1555" },
          ],
        },
      ],
      limit: 500,
    });
    const elapsed = performance.now() - started;
    expect(result.evaluated).toBe(500);
    expect(result.matched).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("ListStreamMessages use case", () => {
  it("paginates with opaque cursor without duplicates or gaps", async () => {
    const streams = new MemoryStreamRepository();
    const created = await streams.insert({
      ownerId: OWNER,
      name: "A",
      mode: "rules",
      rulesJson: [],
      aiPrompt: null,
    });
    for (let i = 0; i < 5; i += 1) {
      streams.seedMembership(created.id, {
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        sender: `+1${i}`,
        bodyCiphertext: codec.encode(OWNER, `body-${i}`),
        receivedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, i)),
        deviceId: DEVICE,
        simSlot: 0,
        direction: "inbound",
        matchedBy: "rule",
        confidence: 1,
        streamVersion: 1,
      });
    }

    const list = new ListStreamMessages({ streams, bodyCodec: codec });
    const page1 = await list.execute({ ownerId: OWNER, streamId: created.id, limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.messages.map((m) => m.body)).toEqual(["body-4", "body-3"]);

    const page2 = await list.execute({
      ownerId: OWNER,
      streamId: created.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.body)).toEqual(["body-2", "body-1"]);

    const page3 = await list.execute({
      ownerId: OWNER,
      streamId: created.id,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.body)).toEqual(["body-0"]);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("returns not_found for other owner's stream", async () => {
    const streams = new MemoryStreamRepository();
    const created = await streams.insert({
      ownerId: OWNER,
      name: "A",
      mode: "rules",
      rulesJson: [],
      aiPrompt: null,
    });
    const list = new ListStreamMessages({ streams, bodyCodec: codec });
    await expect(list.execute({ ownerId: OTHER, streamId: created.id })).rejects.toBeInstanceOf(
      StreamError,
    );
  });
});
