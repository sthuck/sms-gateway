import { describe, expect, it } from "vitest";
import { isSafeRegexPattern, validateRulesJson } from "../../src/domain/stream/index.js";

describe("stream rules validator", () => {
  it("accepts a mixed valid rules tree", () => {
    const result = validateRulesJson([
      { type: "sender_equals", value: "+15551212" },
      { type: "sender_prefix", value: "+44" },
      { type: "body_keyword", match: "any", keywords: ["otp", "code"] },
      { type: "device", device_id: "11111111-1111-4111-8111-111111111111" },
      { type: "sim_slot", slot: 0 },
      {
        type: "or",
        rules: [
          { type: "sender_regex", pattern: "^\\+1" },
          { type: "body_regex", pattern: "OTP" },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns field-pathed errors for bad leaves", () => {
    const result = validateRulesJson([
      { type: "sender_equals" },
      { type: "body_keyword", match: "maybe", keywords: [] },
      { type: "sim_slot", slot: 99 },
      { type: "device", device_id: "not-a-uuid" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain("rules_json[0].value");
    expect(paths).toContain("rules_json[1].match");
    expect(paths).toContain("rules_json[2].slot");
    expect(paths).toContain("rules_json[3].device_id");
  });

  it("rejects non-array rules_json", () => {
    const result = validateRulesJson({ type: "and", rules: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("rules_json");
  });

  it("rejects classic catastrophic backtracking pattern (a+)+$", () => {
    expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    const result = validateRulesJson([{ type: "body_regex", pattern: "(a+)+$" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("rules_json[0].pattern");
    expect(result.issues[0]?.message).toMatch(/unsafe|invalid/i);
  });

  it("rejects other nested quantifier patterns", () => {
    expect(isSafeRegexPattern("(a*)*")).toBe(false);
    expect(isSafeRegexPattern("(a+)*")).toBe(false);
    expect(isSafeRegexPattern("(a|b+)+")).toBe(false);
  });

  it("accepts safe regex patterns", () => {
    expect(isSafeRegexPattern("^\\+1\\d{10}$")).toBe(true);
    expect(isSafeRegexPattern("OTP|code")).toBe(true);
    expect(isSafeRegexPattern("a+")).toBe(true);
  });

  it("rejects empty and overlong patterns", () => {
    expect(isSafeRegexPattern("")).toBe(false);
    expect(isSafeRegexPattern("a".repeat(300))).toBe(false);
  });
});
