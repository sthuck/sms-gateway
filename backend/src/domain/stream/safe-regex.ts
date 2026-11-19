/**
 * ReDoS policy for user-supplied stream rule patterns:
 * - Cap pattern length (`MAX_REGEX_PATTERN_LEN`).
 * - Reject patterns that fail `RegExp` compile.
 * - Reject star-height > 1: a quantifier applied to a group/class/atom that
 *   itself contains a quantifier (e.g. `(a+)+$`, `(a|b+)*`). This is a static
 *   reject, not a match-time timeout — evaluation happens in a later ticket.
 *
 * Built-ins only (domain must stay free of npm packages).
 */

import { MAX_REGEX_PATTERN_LEN } from "./types.js";

const QUANTIFIER_START = new Set(["*", "+", "?", "{"]);

export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LEN) {
    return false;
  }
  try {
    void new RegExp(pattern);
  } catch {
    return false;
  }
  return !hasNestedQuantifiers(pattern);
}

/**
 * Walk the pattern; track whether the current atom/group contains a
 * quantifier. If a quantifier is then applied to that atom, reject.
 */
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
      }
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < pattern.length) {
      // Escaped atom; may be quantified next.
      i += 2;
      if (i < pattern.length && QUANTIFIER_START.has(pattern[i]!)) {
        i = skipQuantifier(pattern, i);
      }
      continue;
    }

    if (ch === "[") {
      peek().inClass = true;
      i += 1;
      // Character class may later be quantified; mark class as quantified atom
      // only when the quantifier is applied after `]`.
      continue;
    }

    if (ch === "(") {
      stack.push({ hasQuantifier: false, inClass: false });
      i += 1;
      // Skip optional group flags like (?:, (?=, (?!, (?<=, (?<!
      if (pattern[i] === "?") {
        i += 1;
        while (
          i < pattern.length &&
          pattern[i] !== ":" &&
          pattern[i] !== ")" &&
          pattern[i] !== "("
        ) {
          // Lookahead / lookbehind / named groups — consume until body.
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
        // Unbalanced — RegExp compile already accepted some edge cases;
        // treat as unsafe rather than throw.
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
      // Quantifier on a single atom that itself isn't a group — only nested
      // when the atom was a quantified thing we already tracked. Lone `a+`
      // is fine; `a++` is invalid and rejected by RegExp compile.
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
    if (pattern[i] === "?") i += 1; // lazy
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
