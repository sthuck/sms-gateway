import type {
  CompileSafeRegex,
  RegexMatcher,
  SafeRegexCompileResult,
} from "../../domain/stream/regex.js";

/**
 * Linear-time regex compile/match for user-supplied stream rules.
 * Infra/native failures during compile should surface as `{ ok: false }`,
 * not `InfrastructureError` — bad patterns are client errors.
 */
export type SafeRegexCompiler = {
  compile: CompileSafeRegex;
};

export type { CompileSafeRegex, RegexMatcher, SafeRegexCompileResult };
