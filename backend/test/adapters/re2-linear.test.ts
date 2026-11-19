import { describe, expect, it } from "vitest";
import { compileSafeRegex } from "../../src/adapters/re2/index.js";
import { checkRegexPatternStatic, testSafeRegex } from "../../src/domain/stream/index.js";

const ADVERSARIAL = `${"a".repeat(32_000)}!`;
const BUDGET_MS = 250;

function assertLinearOrRejected(pattern: string): void {
  const staticCheck = checkRegexPatternStatic(pattern);
  if (!staticCheck.ok) {
    expect(staticCheck.ok).toBe(false);
    return;
  }
  const compiled = compileSafeRegex(pattern);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const start = Date.now();
  const matched = testSafeRegex(compiled.matcher, ADVERSARIAL);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(BUDGET_MS);
  expect(typeof matched).toBe("boolean");
}

describe("RE2 linear-time matching (STH-52)", () => {
  it("rejects or runs former bypasses in linear time on ~32K body", () => {
    for (const pattern of [
      "(a+)+$",
      "(\\d+)+$",
      "(\\w+)*",
      "(\\w+\\s?)*$",
      "(a|a)*$",
      "(a|aa)+$",
      ".*.*.*x",
    ]) {
      assertLinearOrRejected(pattern);
    }
  });

  it("caps haystack length before matching", () => {
    const compiled = compileSafeRegex("x$");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // Only the first MAX_REGEX_INPUT_LEN chars are searched; trailing x is ignored.
    const huge = `${"a".repeat(40_000)}x`;
    expect(testSafeRegex(compiled.matcher, huge)).toBe(false);
  });
});
