import { describe, expect, it } from "vitest";
import { extractMfaClaims, mapClaims } from "../../src/domain/auth/claims.js";

describe("mapClaims", () => {
  it("maps standard claims", () => {
    const mapped = mapClaims({
      sub: "user-1",
      email: "a@example.com",
      name: "Ada",
      amr: ["pwd", "otp"],
      acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
    });
    expect(mapped.sub).toBe("user-1");
    expect(mapped.email).toBe("a@example.com");
    expect(mapped.name).toBe("Ada");
    expect(mapped.amr).toEqual(["pwd", "otp"]);
    expect(mapped.acr).toContain("multi-factor");
  });

  it("uses configured claim names", () => {
    const mapped = mapClaims(
      { sub: "x", preferred_username: "b@example.com", nickname: "Bee" },
      { email: "preferred_username", name: "nickname" },
    );
    expect(mapped.email).toBe("b@example.com");
    expect(mapped.name).toBe("Bee");
  });

  it("requires sub and email", () => {
    expect(() => mapClaims({ email: "a@example.com" })).toThrow(/sub/);
    expect(() => mapClaims({ sub: "x" })).toThrow(/email/);
  });
});

describe("extractMfaClaims", () => {
  it("reads amr/acr without requiring email", () => {
    expect(extractMfaClaims({ sub: "x", amr: ["pwd", "otp"] })).toEqual({
      amr: ["pwd", "otp"],
      acr: null,
    });
    expect(extractMfaClaims({ sub: "x" })).toEqual({ amr: null, acr: null });
  });
});
