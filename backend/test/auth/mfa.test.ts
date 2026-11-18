import { describe, expect, it } from "vitest";
import { evaluateMfa } from "../../src/auth/mfa.js";

describe("evaluateMfa", () => {
  it("passes when MFA is not required", () => {
    const result = evaluateMfa(
      { amr: null, acr: null },
      { requireMfa: false, claimsMissing: "deny" },
    );
    expect(result.ok).toBe(true);
  });

  it("denies missing claims when required", () => {
    const result = evaluateMfa(
      { amr: null, acr: null },
      { requireMfa: true, claimsMissing: "deny" },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("allows missing claims when configured", () => {
    const result = evaluateMfa(
      { amr: null, acr: null },
      { requireMfa: true, claimsMissing: "allow" },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts amr otp as MFA", () => {
    const result = evaluateMfa(
      { amr: ["pwd", "otp"], acr: null },
      { requireMfa: true, claimsMissing: "deny" },
    );
    expect(result.ok).toBe(true);
    expect(result.method).toBe("otp");
  });

  it("accepts acr multi-factor hint", () => {
    const result = evaluateMfa(
      { amr: ["pwd"], acr: "urn:example:aal2" },
      { requireMfa: true, claimsMissing: "deny" },
    );
    expect(result.ok).toBe(true);
    expect(result.method).toBe("urn:example:aal2");
  });

  it("rejects password-only amr when MFA required", () => {
    const result = evaluateMfa(
      { amr: ["pwd"], acr: null },
      { requireMfa: true, claimsMissing: "deny" },
    );
    expect(result.ok).toBe(false);
  });
});
