/**
 * Seam for compiling and matching user-supplied stream regexes.
 * Adapters must use a linear-time engine (RE2); never `new RegExp` on
 * untrusted patterns. D2 preview and STH-24 workers reuse this port.
 */

import { MAX_REGEX_INPUT_LEN, MAX_REGEX_PATTERN_LEN } from "./types.js";

export type RegexMatcher = {
  readonly source: string;
  /** Match against `input` (callers should pass already-capped text). */
  test(input: string): boolean;
};

export type SafeRegexCompileResult =
  | { ok: true; matcher: RegexMatcher }
  | {
      ok: false;
      code: "too_long" | "unsupported_feature" | "invalid" | "unsafe";
      message: string;
    };

export type CompileSafeRegex = (pattern: string) => SafeRegexCompileResult;

/** Cap the haystack before matching — SMS bodies are already ≤ 32 KiB chars. */
export function capRegexInput(input: string, maxLen = MAX_REGEX_INPUT_LEN): string {
  if (input.length <= maxLen) return input;
  return input.slice(0, maxLen);
}

export function testSafeRegex(
  matcher: RegexMatcher,
  input: string,
  maxLen = MAX_REGEX_INPUT_LEN,
): boolean {
  return matcher.test(capRegexInput(input, maxLen));
}

export function assertPatternLength(pattern: string): SafeRegexCompileResult | null {
  if (pattern.length === 0) {
    return { ok: false, code: "invalid", message: "must be a non-empty string" };
  }
  if (pattern.length > MAX_REGEX_PATTERN_LEN) {
    return {
      ok: false,
      code: "too_long",
      message: `must be at most ${MAX_REGEX_PATTERN_LEN} characters`,
    };
  }
  return null;
}
