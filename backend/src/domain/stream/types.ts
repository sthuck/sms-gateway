export type StreamMode = "rules" | "ai" | "hybrid";

export type StreamBackfillStatus = "pending" | "running" | "completed" | "failed";

export const STREAM_MODES = ["rules", "ai", "hybrid"] as const;

/** Caps for rules_json validation (ReDoS / DoS guardrails). */
export const MAX_RULES_DEPTH = 8;
export const MAX_RULES_NODES = 64;
export const MAX_REGEX_PATTERN_LEN = 256;
export const MAX_KEYWORD_LEN = 64;
export const MAX_KEYWORDS = 32;
export const MAX_SENDER_VALUE_LEN = 64;
export const MAX_STREAM_NAME_LEN = 120;
export const MAX_AI_PROMPT_LEN = 4000;

export type SenderEqualsRule = { type: "sender_equals"; value: string };
export type SenderPrefixRule = { type: "sender_prefix"; value: string };
export type SenderRegexRule = { type: "sender_regex"; pattern: string };
export type BodyKeywordRule = {
  type: "body_keyword";
  match: "any" | "all";
  keywords: string[];
};
export type BodyRegexRule = { type: "body_regex"; pattern: string };
export type DeviceRule = { type: "device"; device_id: string };
export type SimSlotRule = { type: "sim_slot"; slot: number };
export type AndGroup = { type: "and"; rules: StreamRule[] };
export type OrGroup = { type: "or"; rules: StreamRule[] };

/**
 * One node in `rules_json`. Top-level `rules_json` is an array of these
 * (implicit AND for evaluation in a later ticket). Groups nest via `and`/`or`.
 */
export type StreamRule =
  | SenderEqualsRule
  | SenderPrefixRule
  | SenderRegexRule
  | BodyKeywordRule
  | BodyRegexRule
  | DeviceRule
  | SimSlotRule
  | AndGroup
  | OrGroup;

export type Stream = {
  id: string;
  ownerId: string;
  name: string;
  mode: StreamMode;
  rulesJson: StreamRule[];
  aiPrompt: string | null;
  version: number;
  backfillStatus: StreamBackfillStatus;
  createdAt: Date;
  updatedAt: Date;
};
