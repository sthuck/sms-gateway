import { describe, expect, it } from "vitest";
import { isSessionActive } from "../../src/domain/auth/session.js";

describe("isSessionActive", () => {
  const base = {
    sessionRowId: "r1",
    ownerId: "o1",
    csrfTokenHash: "h",
    expiresAt: new Date("2026-01-02T00:00:00.000Z"),
    revokedAt: null as Date | null,
  };

  it("is active before expiry", () => {
    expect(isSessionActive(base, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("is inactive when expired or revoked", () => {
    expect(isSessionActive(base, new Date("2026-01-03T00:00:00.000Z"))).toBe(false);
    expect(
      isSessionActive(
        { ...base, revokedAt: new Date("2026-01-01T12:00:00.000Z") },
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
