import { isSafeRegexPattern } from "./safe-regex.js";
import type { StreamFieldError } from "./errors.js";
import {
  MAX_AI_PROMPT_LEN,
  MAX_KEYWORD_LEN,
  MAX_KEYWORDS,
  MAX_REGEX_PATTERN_LEN,
  MAX_RULES_DEPTH,
  MAX_RULES_NODES,
  MAX_SENDER_VALUE_LEN,
  MAX_STREAM_NAME_LEN,
  STREAM_MODES,
  type StreamMode,
  type StreamRule,
} from "./types.js";

export type RulesValidation =
  { ok: true; value: StreamRule[] } | { ok: false; issues: StreamFieldError[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LEAF_TYPES = new Set([
  "sender_equals",
  "sender_prefix",
  "sender_regex",
  "body_keyword",
  "body_regex",
  "device",
  "sim_slot",
]);

/**
 * Validate `rules_json` as a pure function. Returns field-pathed issues
 * (e.g. `rules_json[0].pattern`) suitable for `invalid_request` responses.
 */
export function validateRulesJson(raw: unknown, path = "rules_json"): RulesValidation {
  const issues: StreamFieldError[] = [];
  if (!Array.isArray(raw)) {
    return { ok: false, issues: [{ path, message: "must be an array" }] };
  }

  let nodeCount = 0;
  const rules: StreamRule[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = parseRule(
      raw[i],
      `${path}[${i}]`,
      1,
      () => {
        nodeCount += 1;
        if (nodeCount > MAX_RULES_NODES) {
          issues.push({
            path,
            message: `exceeds maximum of ${MAX_RULES_NODES} rule nodes`,
          });
        }
      },
      issues,
    );
    if (parsed) rules.push(parsed);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: rules };
}

export function validateStreamName(name: unknown, path = "name"): StreamFieldError | null {
  if (typeof name !== "string" || name.trim().length === 0) {
    return { path, message: "must be a non-empty string" };
  }
  if (name.length > MAX_STREAM_NAME_LEN) {
    return { path, message: `must be at most ${MAX_STREAM_NAME_LEN} characters` };
  }
  return null;
}

export function validateStreamMode(mode: unknown, path = "mode"): StreamFieldError | null {
  if (typeof mode !== "string" || !(STREAM_MODES as readonly string[]).includes(mode)) {
    return { path, message: `must be one of ${STREAM_MODES.join(", ")}` };
  }
  return null;
}

export function validateAiPrompt(prompt: unknown, path = "ai_prompt"): StreamFieldError | null {
  if (prompt === null || prompt === undefined) return null;
  if (typeof prompt !== "string") {
    return { path, message: "must be a string or null" };
  }
  if (prompt.length > MAX_AI_PROMPT_LEN) {
    return { path, message: `must be at most ${MAX_AI_PROMPT_LEN} characters` };
  }
  return null;
}

export function isStreamMode(value: string): value is StreamMode {
  return (STREAM_MODES as readonly string[]).includes(value);
}

function parseRule(
  raw: unknown,
  path: string,
  depth: number,
  onNode: () => void,
  issues: StreamFieldError[],
): StreamRule | null {
  onNode();
  if (issues.some((i) => i.message.includes("maximum of"))) return null;

  if (depth > MAX_RULES_DEPTH) {
    issues.push({ path, message: `exceeds maximum nesting depth of ${MAX_RULES_DEPTH}` });
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path, message: "must be an object" });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") {
    issues.push({ path: `${path}.type`, message: "is required" });
    return null;
  }

  if (type === "and" || type === "or") {
    if (!Array.isArray(obj.rules)) {
      issues.push({ path: `${path}.rules`, message: "must be an array" });
      return null;
    }
    if (obj.rules.length === 0) {
      issues.push({ path: `${path}.rules`, message: "must not be empty" });
      return null;
    }
    const children: StreamRule[] = [];
    for (let i = 0; i < obj.rules.length; i += 1) {
      const child = parseRule(obj.rules[i], `${path}.rules[${i}]`, depth + 1, onNode, issues);
      if (child) children.push(child);
    }
    assertNoUnknownKeys(obj, ["type", "rules"], path, issues);
    if (issues.length > 0) return null;
    return { type, rules: children };
  }

  if (!LEAF_TYPES.has(type)) {
    issues.push({
      path: `${path}.type`,
      message:
        "must be one of sender_equals, sender_prefix, sender_regex, body_keyword, body_regex, device, sim_slot, and, or",
    });
    return null;
  }

  switch (type) {
    case "sender_equals":
    case "sender_prefix": {
      const value = obj.value;
      if (typeof value !== "string" || value.length === 0) {
        issues.push({ path: `${path}.value`, message: "must be a non-empty string" });
        return null;
      }
      if (value.length > MAX_SENDER_VALUE_LEN) {
        issues.push({
          path: `${path}.value`,
          message: `must be at most ${MAX_SENDER_VALUE_LEN} characters`,
        });
        return null;
      }
      assertNoUnknownKeys(obj, ["type", "value"], path, issues);
      if (issues.length > 0) return null;
      return { type, value };
    }
    case "sender_regex":
    case "body_regex": {
      const pattern = obj.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        issues.push({ path: `${path}.pattern`, message: "must be a non-empty string" });
        return null;
      }
      if (pattern.length > MAX_REGEX_PATTERN_LEN) {
        issues.push({
          path: `${path}.pattern`,
          message: `must be at most ${MAX_REGEX_PATTERN_LEN} characters`,
        });
        return null;
      }
      if (!isSafeRegexPattern(pattern)) {
        issues.push({
          path: `${path}.pattern`,
          message: "rejected as unsafe or invalid regular expression",
        });
        return null;
      }
      assertNoUnknownKeys(obj, ["type", "pattern"], path, issues);
      if (issues.length > 0) return null;
      return { type, pattern };
    }
    case "body_keyword": {
      const match = obj.match;
      if (match !== "any" && match !== "all") {
        issues.push({ path: `${path}.match`, message: "must be any or all" });
        return null;
      }
      if (!Array.isArray(obj.keywords) || obj.keywords.length === 0) {
        issues.push({ path: `${path}.keywords`, message: "must be a non-empty array" });
        return null;
      }
      if (obj.keywords.length > MAX_KEYWORDS) {
        issues.push({
          path: `${path}.keywords`,
          message: `must have at most ${MAX_KEYWORDS} entries`,
        });
        return null;
      }
      const keywords: string[] = [];
      for (let i = 0; i < obj.keywords.length; i += 1) {
        const kw = obj.keywords[i];
        if (typeof kw !== "string" || kw.length === 0) {
          issues.push({
            path: `${path}.keywords[${i}]`,
            message: "must be a non-empty string",
          });
          continue;
        }
        if (kw.length > MAX_KEYWORD_LEN) {
          issues.push({
            path: `${path}.keywords[${i}]`,
            message: `must be at most ${MAX_KEYWORD_LEN} characters`,
          });
          continue;
        }
        keywords.push(kw);
      }
      assertNoUnknownKeys(obj, ["type", "match", "keywords"], path, issues);
      if (issues.length > 0) return null;
      return { type: "body_keyword", match, keywords };
    }
    case "device": {
      const deviceId = obj.device_id;
      if (typeof deviceId !== "string" || !UUID_RE.test(deviceId)) {
        issues.push({ path: `${path}.device_id`, message: "must be a UUID" });
        return null;
      }
      assertNoUnknownKeys(obj, ["type", "device_id"], path, issues);
      if (issues.length > 0) return null;
      return { type: "device", device_id: deviceId };
    }
    case "sim_slot": {
      const slot = obj.slot;
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 9) {
        issues.push({ path: `${path}.slot`, message: "must be an integer between 0 and 9" });
        return null;
      }
      assertNoUnknownKeys(obj, ["type", "slot"], path, issues);
      if (issues.length > 0) return null;
      return { type: "sim_slot", slot };
    }
    default:
      return null;
  }
}

function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: StreamFieldError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, message: "is not allowed" });
    }
  }
}

export function formatRuleIssues(issues: StreamFieldError[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}
