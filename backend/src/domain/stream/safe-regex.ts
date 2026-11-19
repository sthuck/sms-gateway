/**
 * Static ReDoS / feature guardrails for user-supplied patterns.
 * Defence in depth only — compile and match MUST go through the
 * `CompileSafeRegex` seam (RE2 adapter). Never call `new RegExp` here.
 *
 * Policy:
 * - Cap pattern length.
 * - Reject lookaround and backreferences (RE2 unsupported; clear errors).
 * - Reject star-height > 1 (nested quantifiers), including quantified
 *   escaped atoms (`\d+` inside `(…)+`) and quantified character classes.
 */

import { MAX_REGEX_PATTERN_LEN } from "./types.js";

const QUANTIFIER_START = new Set(["*", "+", "?", "{"]);

export type StaticRegexCheck =
  | { ok: true }
  | { ok: false; code: "too_long" | "unsupported_feature" | "unsafe"; message: string };

export function checkRegexPatternStatic(pattern: string): StaticRegexCheck {
  if (pattern.length === 0) {
    return { ok: false, code: "unsafe", message: "must be a non-empty string" };
  }
  if (pattern.length > MAX_REGEX_PATTERN_LEN) {
    return {
      ok: false,
      code: "too_long",
      message: `must be at most ${MAX_REGEX_PATTERN_LEN} characters`,
    };
  }

  const unsupported = findUnsupportedFeature(pattern);
  if (unsupported) {
    return { ok: false, code: "unsupported_feature", message: unsupported };
  }

  if (hasNestedQuantifiers(pattern)) {
    return {
      ok: false,
      code: "unsafe",
      message: "rejected as unsafe or invalid regular expression",
    };
  }

  return { ok: true };
}

/** @deprecated Prefer checkRegexPatternStatic — kept for existing test imports. */
export function isSafeRegexPattern(pattern: string): boolean {
  return checkRegexPatternStatic(pattern).ok;
}

/**
 * RE2 does not support lookaround or backreferences. Detect them for
 * field-pathed validation messages before the engine rejects them.
 */
function findUnsupportedFeature(pattern: string): string | null {
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (inClass) {
      if (ch === "\\" && i + 1 < pattern.length) {
        i += 2;
        continue;
      }
      if (ch === "]") inClass = false;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1]!;
      if (next >= "1" && next <= "9") {
        return "backreference not supported";
      }
      if (next === "k") {
        return "backreference not supported";
      }
      i += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "(" && pattern[i + 1] === "?") {
      const after = pattern[i + 2];
      if (after === "=" || after === "!") {
        return "lookahead/backreference not supported";
      }
      if (after === "<") {
        const look = pattern[i + 3];
        if (look === "=" || look === "!") {
          return "lookahead/backreference not supported";
        }
      }
    }
    i += 1;
  }
  return null;
}

function hasNestedQuantifiers(pattern: string): boolean {
  type Frame = { hasQuantifier: boolean; inClass: boolean };
  const stack: Frame[] = [{ hasQuantifier: false, inClass: false }];
  let i = 0;

  const peek = (): Frame => stack[stack.length - 1]!;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (peek().inClass) {
      if (ch === "\\" && i + 1 < pattern.length) {
        i += 2;
        continue;
      }
      if (ch === "]") {
        peek().inClass = false;
        i += 1;
        if (i < pattern.length && QUANTIFIER_START.has(pattern[i]!)) {
          peek().hasQuantifier = true;
          i = skipQuantifier(pattern, i);
        }
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < pattern.length) {
      i += 2;
      if (i < pattern.length && QUANTIFIER_START.has(pattern[i]!)) {
        peek().hasQuantifier = true;
        i = skipQuantifier(pattern, i);
      }
      continue;
    }

    if (ch === "[") {
      peek().inClass = true;
      i += 1;
      continue;
    }

    if (ch === "(") {
      stack.push({ hasQuantifier: false, inClass: false });
      i += 1;
      if (pattern[i] === "?") {
        i += 1;
        while (
          i < pattern.length &&
          pattern[i] !== ":" &&
          pattern[i] !== ")" &&
          pattern[i] !== "("
        ) {
          if (
            pattern[i] === "<" ||
            pattern[i] === "=" ||
            pattern[i] === "!" ||
            pattern[i] === "'"
          ) {
            break;
          }
          i += 1;
        }
        if (pattern[i] === ":") i += 1;
      }
      continue;
    }

    if (ch === ")") {
      if (stack.length === 1) {
        return true;
      }
      const closed = stack.pop()!;
      i += 1;
      if (i < pattern.length && QUANTIFIER_START.has(pattern[i]!)) {
        if (closed.hasQuantifier) {
          return true;
        }
        peek().hasQuantifier = true;
        i = skipQuantifier(pattern, i);
      } else if (closed.hasQuantifier) {
        peek().hasQuantifier = true;
      }
      continue;
    }

    if (QUANTIFIER_START.has(ch)) {
      peek().hasQuantifier = true;
      i = skipQuantifier(pattern, i);
      continue;
    }

    i += 1;
  }

  return false;
}

function skipQuantifier(pattern: string, i: number): number {
  const ch = pattern[i]!;
  if (ch === "*" || ch === "+" || ch === "?") {
    i += 1;
    if (pattern[i] === "?") i += 1;
    return i;
  }
  if (ch === "{") {
    i += 1;
    while (i < pattern.length && pattern[i] !== "}") i += 1;
    if (pattern[i] === "}") i += 1;
    if (pattern[i] === "?") i += 1;
    return i;
  }
  return i + 1;
}
