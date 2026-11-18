import { describe, expect, it } from "vitest";
import { formatPhoneSender } from "../../src/adapters/phone/index.js";
import {
  normaliseDirection,
  normaliseReceivedAt,
  normaliseSender,
  normaliseSimSlot,
  validateBatchItem,
} from "../../src/domain/message/index.js";

describe("message normalisation", () => {
  it("formats phone senders to E.164 and keeps alphanumeric senders", () => {
    expect(normaliseSender("+15551234567", "US", formatPhoneSender)).toEqual({
      ok: true,
      sender: "+15551234567",
    });
    expect(normaliseSender("5551234567", "US", formatPhoneSender)).toEqual({
      ok: true,
      sender: "+15551234567",
    });
    expect(normaliseSender("BankAlert", "US", formatPhoneSender)).toEqual({
      ok: true,
      sender: "BankAlert",
    });
    expect(normaliseSender("VERIFY", "US", formatPhoneSender)).toEqual({
      ok: true,
      sender: "VERIFY",
    });
  });

  it("requires UTC Z timestamps and rejects far-future values", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(normaliseReceivedAt("2026-11-18T09:45:12Z", now)).toEqual({
      ok: true,
      receivedAt: new Date("2026-11-18T09:45:12Z"),
    });
    expect(normaliseReceivedAt("2026-11-18T09:45:12.123Z", now).ok).toBe(true);
    expect(normaliseReceivedAt("2026-11-18T09:45:12+00:00", now).ok).toBe(false);
    expect(normaliseReceivedAt("2099-01-01T00:00:00Z", now)).toMatchObject({
      ok: false,
      code: "invalid_field",
    });
  });

  it("validates sim_slot and direction", () => {
    expect(normaliseSimSlot(undefined)).toEqual({ ok: true, simSlot: null });
    expect(normaliseSimSlot(9)).toEqual({ ok: true, simSlot: 9 });
    expect(normaliseSimSlot(10).ok).toBe(false);
    expect(normaliseDirection("inbound")).toEqual({ ok: true, direction: "inbound" });
    expect(normaliseDirection("outbound")).toEqual({ ok: true, direction: "outbound" });
    expect(normaliseDirection("sideways").ok).toBe(false);
  });

  it("ignores owner/device injection fields during item validation", () => {
    const result = validateBatchItem(
      {
        device_msg_id: "sms-1",
        sender: "+15551234567",
        body: "hi",
        received_at: "2026-11-18T09:45:12Z",
        direction: "inbound",
        owner_id: "00000000-0000-4000-8000-000000000099",
        device_id: "00000000-0000-4000-8000-000000000098",
      },
      "US",
      formatPhoneSender,
      new Date("2026-11-18T12:00:00Z"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deviceMsgId).toBe("sms-1");
      expect(result.value).not.toHaveProperty("owner_id");
    }
  });
});
