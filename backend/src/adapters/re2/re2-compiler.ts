import { createRequire } from "node:module";
import {
  assertPatternLength,
  capRegexInput,
  type CompileSafeRegex,
  type RegexMatcher,
  type SafeRegexCompileResult,
} from "../../domain/stream/regex.js";
import { MAX_REGEX_INPUT_LEN } from "../../domain/stream/types.js";
import { checkRegexPatternStatic } from "../../domain/stream/safe-regex.js";
import type { SafeRegexCompiler } from "../../ports/outbound/safe-regex.js";

const require = createRequire(import.meta.url);

type Re2Ctor = new (
  pattern: string,
  flags?: string,
) => {
  test(input: string): boolean;
  source: string;
};

function loadRe2(): Re2Ctor {
  // re2-wasm is CJS; createRequire keeps WASM path resolution working under ESM.
  const mod = require("re2-wasm") as { RE2: Re2Ctor } | { default: { RE2: Re2Ctor } };
  if ("RE2" in mod && typeof mod.RE2 === "function") return mod.RE2;
  if ("default" in mod && mod.default?.RE2) return mod.default.RE2;
  throw new Error("re2-wasm RE2 export missing");
}

const RE2 = loadRe2();

function mapCompileError(err: unknown): SafeRegexCompileResult {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("perl operator") ||
    lower.includes("lookahead") ||
    lower.includes("lookbehind") ||
    lower.includes("invalid escape sequence: \\") ||
    /\\[1-9]/.test(message)
  ) {
    return {
      ok: false,
      code: "unsupported_feature",
      message: "lookahead/backreference not supported",
    };
  }
  return {
    ok: false,
    code: "invalid",
    message: "rejected as unsafe or invalid regular expression",
  };
}

/**
 * Compile a user pattern with RE2 (linear-time). Applies static guards first,
 * then RE2 compile. Matchers cap haystacks to `MAX_REGEX_INPUT_LEN`.
 */
export const compileSafeRegex: CompileSafeRegex = (pattern) => {
  const lengthErr = assertPatternLength(pattern);
  if (lengthErr) return lengthErr;

  const staticCheck = checkRegexPatternStatic(pattern);
  if (!staticCheck.ok) {
    return {
      ok: false,
      code: staticCheck.code === "too_long" ? "too_long" : staticCheck.code,
      message: staticCheck.message,
    };
  }

  try {
    const re = new RE2(pattern, "u");
    const matcher: RegexMatcher = {
      source: pattern,
      test(input: string): boolean {
        return re.test(capRegexInput(input, MAX_REGEX_INPUT_LEN));
      },
    };
    return { ok: true, matcher };
  } catch (err) {
    return mapCompileError(err);
  }
};

export class Re2SafeRegexCompiler implements SafeRegexCompiler {
  compile = compileSafeRegex;
}
