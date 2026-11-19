import { describe, expect, it } from "vitest";
import { FORBIDDEN_PAYLOAD_KEYS, parseQueueEvent } from "../../src/queue/events.js";

describe("queue event payloads", () => {
  it("accepts ID-only message.created", () => {
    const event = parseQueueEvent({
      type: "message.created",
      owner_id: "11111111-1111-4111-8111-111111111111",
      message_id: "22222222-2222-4222-8222-222222222222",
      device_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(event.type).toBe("message.created");
  });

  it("accepts ID-only stream.reclassify with version", () => {
    const event = parseQueueEvent({
      type: "stream.reclassify",
      owner_id: "11111111-1111-4111-8111-111111111111",
      stream_id: "44444444-4444-4444-8444-444444444444",
      version: 2,
    });
    expect(event.type).toBe("stream.reclassify");
    if (event.type === "stream.reclassify") {
      expect(event.version).toBe(2);
    }
  });

  it("rejects stream.reclassify without version", () => {
    expect(() =>
      parseQueueEvent({
        type: "stream.reclassify",
        owner_id: "11111111-1111-4111-8111-111111111111",
        stream_id: "44444444-4444-4444-8444-444444444444",
      }),
    ).toThrow();
  });

  it("rejects message bodies and senders", () => {
    expect(() =>
      parseQueueEvent({
        type: "message.created",
        owner_id: "11111111-1111-4111-8111-111111111111",
        message_id: "22222222-2222-4222-8222-222222222222",
        device_id: "33333333-3333-4333-8333-333333333333",
        body: "secret sms text",
      }),
    ).toThrow(/must not include "body"/);

    expect(() =>
      parseQueueEvent({
        type: "message.created",
        owner_id: "11111111-1111-4111-8111-111111111111",
        message_id: "22222222-2222-4222-8222-222222222222",
        device_id: "33333333-3333-4333-8333-333333333333",
        sender: "+15551212",
      }),
    ).toThrow(/must not include "sender"/);
  });

  it("rejects nested forbidden keys", () => {
    expect(() =>
      parseQueueEvent({
        type: "stream.reclassify",
        owner_id: "11111111-1111-4111-8111-111111111111",
        stream_id: "44444444-4444-4444-8444-444444444444",
        version: 1,
        meta: { body_ciphertext: "aa" },
      }),
    ).toThrow(/body_ciphertext/);
  });

  it("lists the forbidden keys used by the guard", () => {
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("body");
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("sender");
  });
});
