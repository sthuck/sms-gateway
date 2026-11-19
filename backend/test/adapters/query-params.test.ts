import { describe, expect, it } from "vitest";
import {
  listDevicesQuerySchema,
  listMessagesQuerySchema,
} from "../../src/adapters/http-fastify/query-params.js";

describe("owner list query schemas", () => {
  it("accepts single-valued message filters", () => {
    const parsed = listMessagesQuerySchema.safeParse({
      limit: "10",
      cursor: "abc",
      device_id: "00000000-0000-4000-8000-000000000001",
      sender: "+1",
      received_after: "2026-01-01T00:00:00Z",
      received_before: "2026-02-01T00:00:00Z",
      q: "otp",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects repeated/array message query params", () => {
    for (const key of [
      "q",
      "limit",
      "cursor",
      "device_id",
      "sender",
      "received_after",
      "received_before",
    ] as const) {
      const parsed = listMessagesQuerySchema.safeParse({ [key]: ["a", "b"] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === key)).toBe(true);
      }
    }
  });

  it("rejects non-string message query values", () => {
    const parsed = listMessagesQuerySchema.safeParse({ limit: 10 });
    expect(parsed.success).toBe(false);
  });

  it("rejects NUL in sender and q", () => {
    for (const key of ["sender", "q"] as const) {
      const parsed = listMessagesQuerySchema.safeParse({ [key]: "a\u0000b" });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === key)).toBe(true);
      }
    }
  });

  it("rejects repeated device list limit", () => {
    const parsed = listDevicesQuerySchema.safeParse({ limit: ["1", "2"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === "limit")).toBe(true);
    }
  });
});
