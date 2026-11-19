/**
 * Pure stream rule evaluator over a message view.
 * Independent of HTTP/DB so STH-24 workers can reuse it.
 * User regexes match only via CompileSafeRegex (never `new RegExp`).
 */

import { capRegexInput, type CompileSafeRegex, type RegexMatcher } from "./regex.js";
import type { StreamRule } from "./types.js";

/** Fields needed to evaluate rules against one message. */
export type MessageView = {
  id: string;
  sender: string;
  body: string;
  deviceId: string;
  simSlot: number | null;
};

export type MatchedRuleRef = {
  /** Field path, e.g. `rules_json[0]` or `rules_json[1].rules[0]`. */
  path: string;
  type: StreamRule["type"];
};

export type RuleEvalResult = {
  matched: boolean;
  /** Set when a concrete leaf/group match is cheap to report. */
  matchedRule: MatchedRuleRef | null;
};

type PreparedLeaf =
  | { kind: "sender_equals"; value: string }
  | { kind: "sender_prefix"; value: string }
  | { kind: "sender_regex"; matcher: RegexMatcher }
  | { kind: "body_keyword"; match: "any" | "all"; keywordsLower: string[] }
  | { kind: "body_regex"; matcher: RegexMatcher }
  | { kind: "device"; deviceId: string }
  | { kind: "sim_slot"; slot: number };

type PreparedNode =
  | { kind: "leaf"; path: string; type: StreamRule["type"]; leaf: PreparedLeaf }
  | { kind: "and"; path: string; children: PreparedNode[] }
  | { kind: "or"; path: string; children: PreparedNode[] };

export type PreparedRules = {
  root: PreparedNode[];
};

/**
 * Compile validated rules once (regex leaves → matchers) for repeated
 * evaluation over many messages.
 */
export function prepareRules(rules: StreamRule[], compile: CompileSafeRegex): PreparedRules {
  return {
    root: rules.map((rule, i) => prepareNode(rule, `rules_json[${i}]`, compile)),
  };
}

/**
 * Top-level `rules_json` is an implicit AND. Empty array matches everything
 * (vacuous truth — useful for ai-only definitions when only rules are run).
 */
export function evaluatePrepared(prepared: PreparedRules, message: MessageView): RuleEvalResult {
  if (prepared.root.length === 0) {
    return { matched: true, matchedRule: null };
  }
  if (prepared.root.length === 1) {
    return evalNode(prepared.root[0]!, message);
  }
  for (const child of prepared.root) {
    const result = evalNode(child, message);
    if (!result.matched) {
      return { matched: false, matchedRule: null };
    }
  }
  return { matched: true, matchedRule: { path: "rules_json", type: "and" } };
}

/** Convenience: prepare + evaluate a single message. */
export function evaluateRules(
  rules: StreamRule[],
  message: MessageView,
  compile: CompileSafeRegex,
): RuleEvalResult {
  return evaluatePrepared(prepareRules(rules, compile), message);
}

export const DEFAULT_BODY_SNIPPET_LEN = 160;

export function bodySnippet(body: string, maxLen = DEFAULT_BODY_SNIPPET_LEN): string {
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen);
}

function prepareNode(rule: StreamRule, path: string, compile: CompileSafeRegex): PreparedNode {
  if (rule.type === "and") {
    return {
      kind: "and",
      path,
      children: rule.rules.map((child, i) => prepareNode(child, `${path}.rules[${i}]`, compile)),
    };
  }
  if (rule.type === "or") {
    return {
      kind: "or",
      path,
      children: rule.rules.map((child, i) => prepareNode(child, `${path}.rules[${i}]`, compile)),
    };
  }

  return {
    kind: "leaf",
    path,
    type: rule.type,
    leaf: prepareLeaf(rule, compile),
  };
}

type LeafRule = Exclude<StreamRule, { type: "and" } | { type: "or" }>;

function prepareLeaf(rule: LeafRule, compile: CompileSafeRegex): PreparedLeaf {
  switch (rule.type) {
    case "sender_equals":
      return { kind: "sender_equals", value: rule.value };
    case "sender_prefix":
      return { kind: "sender_prefix", value: rule.value };
    case "sender_regex": {
      const compiled = compile(rule.pattern);
      if (!compiled.ok) {
        throw new Error(`prepareRules: unexpected regex compile failure: ${compiled.message}`);
      }
      return { kind: "sender_regex", matcher: compiled.matcher };
    }
    case "body_keyword":
      return {
        kind: "body_keyword",
        match: rule.match,
        keywordsLower: rule.keywords.map((k) => k.toLowerCase()),
      };
    case "body_regex": {
      const compiled = compile(rule.pattern);
      if (!compiled.ok) {
        throw new Error(`prepareRules: unexpected regex compile failure: ${compiled.message}`);
      }
      return { kind: "body_regex", matcher: compiled.matcher };
    }
    case "device":
      return { kind: "device", deviceId: rule.device_id };
    case "sim_slot":
      return { kind: "sim_slot", slot: rule.slot };
    default: {
      const _exhaustive: never = rule;
      void _exhaustive;
      throw new Error("prepareRules: unknown rule type");
    }
  }
}

function evalNode(node: PreparedNode, message: MessageView): RuleEvalResult {
  if (node.kind === "and") {
    for (const child of node.children) {
      const result = evalNode(child, message);
      if (!result.matched) return { matched: false, matchedRule: null };
    }
    return { matched: true, matchedRule: { path: node.path, type: "and" } };
  }
  if (node.kind === "or") {
    for (const child of node.children) {
      const result = evalNode(child, message);
      if (result.matched) {
        return {
          matched: true,
          matchedRule: result.matchedRule ?? { path: node.path, type: "or" },
        };
      }
    }
    return { matched: false, matchedRule: null };
  }

  const hit = evalLeaf(node.leaf, message);
  return hit
    ? { matched: true, matchedRule: { path: node.path, type: node.type } }
    : { matched: false, matchedRule: null };
}

function evalLeaf(leaf: PreparedLeaf, message: MessageView): boolean {
  switch (leaf.kind) {
    case "sender_equals":
      return message.sender === leaf.value;
    case "sender_prefix":
      return message.sender.startsWith(leaf.value);
    case "sender_regex":
      return leaf.matcher.test(capRegexInput(message.sender));
    case "body_keyword": {
      const bodyLower = message.body.toLowerCase();
      if (leaf.match === "any") {
        return leaf.keywordsLower.some((kw) => bodyLower.includes(kw));
      }
      return leaf.keywordsLower.every((kw) => bodyLower.includes(kw));
    }
    case "body_regex":
      return leaf.matcher.test(capRegexInput(message.body));
    case "device":
      return message.deviceId === leaf.deviceId;
    case "sim_slot":
      return message.simSlot === leaf.slot;
    default: {
      const _exhaustive: never = leaf;
      void _exhaustive;
      return false;
    }
  }
}
