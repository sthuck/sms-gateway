import { describe, expect, it } from "vitest";
import {
  checkRegexPatternStatic,
  isSafeRegexPattern,
  validateRulesJson,
} from "../../src/domain/stream/index.js";
import { compileSafeRegex } from "../../src/adapters/re2/index.js";

describe("stream rules validator", () => {
  it("accepts a mixed valid rules tree", () => {
    const result = validateRulesJson(
      [
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
      ],
      compileSafeRegex,
    );
    expect(result.ok).toBe(true);
  });

  it("returns field-pathed errors for bad leaves", () => {
    const result = validateRulesJson(
      [
        { type: "sender_equals" },
        { type: "body_keyword", match: "maybe", keywords: [] },
        { type: "sim_slot", slot: 99 },
        { type: "device", device_id: "not-a-uuid" },
      ],
      compileSafeRegex,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain("rules_json[0].value");
    expect(paths).toContain("rules_json[1].match");
    expect(paths).toContain("rules_json[2].slot");
    expect(paths).toContain("rules_json[3].device_id");
  });

  it("rejects non-array rules_json", () => {
    const result = validateRulesJson({ type: "and", rules: [] }, compileSafeRegex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("rules_json");
  });

  it("rejects classic catastrophic backtracking pattern (a+)+$", () => {
    expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    const result = validateRulesJson([{ type: "body_regex", pattern: "(a+)+$" }], compileSafeRegex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("rules_json[0].pattern");
    expect(result.issues[0]?.message).toMatch(/unsafe|invalid/i);
  });

  it("rejects nested quantifiers on escaped atoms (former bypasses)", () => {
    expect(checkRegexPatternStatic("(\\d+)+$").ok).toBe(false);
    expect(checkRegexPatternStatic("(\\w+)*").ok).toBe(false);
    expect(checkRegexPatternStatic("(\\w+\\s?)*$").ok).toBe(false);
  });

  it("rejects other nested quantifier patterns", () => {
    expect(isSafeRegexPattern("(a*)*")).toBe(false);
    expect(isSafeRegexPattern("(a+)*")).toBe(false);
    expect(isSafeRegexPattern("(a|b+)+")).toBe(false);
  });

  it("accepts safe regex patterns via RE2", () => {
    expect(compileSafeRegex("^\\+1\\d{10}$").ok).toBe(true);
    expect(compileSafeRegex("OTP|code").ok).toBe(true);
    expect(compileSafeRegex("a+").ok).toBe(true);
  });

  it("rejects empty and overlong patterns", () => {
    expect(isSafeRegexPattern("")).toBe(false);
    expect(isSafeRegexPattern("a".repeat(300))).toBe(false);
  });

  it("rejects lookahead and backreferences with clear messages", () => {
    const look = validateRulesJson(
      [{ type: "body_regex", pattern: "(?=OTP)secret" }],
      compileSafeRegex,
    );
    expect(look.ok).toBe(false);
    if (!look.ok) {
      expect(look.issues[0]?.path).toBe("rules_json[0].pattern");
      expect(look.issues[0]?.message).toMatch(/lookahead\/backreference not supported/);
    }

    const back = validateRulesJson([{ type: "body_regex", pattern: "(a)\\1" }], compileSafeRegex);
    expect(back.ok).toBe(false);
    if (!back.ok) {
      expect(back.issues[0]?.message).toMatch(/backreference not supported|lookahead/);
    }
  });

  it("matches normal patterns correctly through the seam", () => {
    const compiled = compileSafeRegex("OTP|code");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.matcher.test("your OTP is 1")).toBe(true);
    expect(compiled.matcher.test("hello")).toBe(false);
  });
});
