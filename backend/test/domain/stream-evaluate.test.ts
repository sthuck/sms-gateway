import { describe, expect, it } from "vitest";
import {
  bodySnippet,
  evaluatePrepared,
  evaluateRules,
  prepareRules,
  type MessageView,
} from "../../src/domain/stream/index.js";
import type { StreamRule } from "../../src/domain/stream/types.js";
import { compileSafeRegex } from "../../src/adapters/re2/index.js";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";

function msg(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sender: "+15551212",
    body: "Your OTP is 123456",
    deviceId: DEVICE,
    simSlot: 0,
    ...overrides,
  };
}

describe("stream rule evaluator", () => {
  it("sender_equals", () => {
    const rules: StreamRule[] = [{ type: "sender_equals", value: "+15551212" }];
    expect(evaluateRules(rules, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(rules, msg({ sender: "+1999" }), compileSafeRegex).matched).toBe(false);
  });

  it("sender_prefix", () => {
    const rules: StreamRule[] = [{ type: "sender_prefix", value: "+1555" }];
    expect(evaluateRules(rules, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(rules, msg({ sender: "+441" }), compileSafeRegex).matched).toBe(false);
  });

  it("sender_regex via SafeRegex seam", () => {
    const rules: StreamRule[] = [{ type: "sender_regex", pattern: "^\\+1" }];
    const hit = evaluateRules(rules, msg(), compileSafeRegex);
    expect(hit.matched).toBe(true);
    expect(hit.matchedRule).toEqual({ path: "rules_json[0]", type: "sender_regex" });
    expect(evaluateRules(rules, msg({ sender: "Bank" }), compileSafeRegex).matched).toBe(false);
  });

  it("body_keyword any/all (case-insensitive)", () => {
    const any: StreamRule[] = [{ type: "body_keyword", match: "any", keywords: ["otp", "code"] }];
    expect(evaluateRules(any, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(any, msg({ body: "hello code" }), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(any, msg({ body: "hello" }), compileSafeRegex).matched).toBe(false);

    const all: StreamRule[] = [{ type: "body_keyword", match: "all", keywords: ["otp", "123456"] }];
    expect(evaluateRules(all, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(all, msg({ body: "otp only" }), compileSafeRegex).matched).toBe(false);
  });

  it("body_regex via SafeRegex seam with haystack cap", () => {
    const rules: StreamRule[] = [{ type: "body_regex", pattern: "OTP" }];
    expect(evaluateRules(rules, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(rules, msg({ body: "nope" }), compileSafeRegex).matched).toBe(false);
  });

  it("device and sim_slot", () => {
    expect(
      evaluateRules([{ type: "device", device_id: DEVICE }], msg(), compileSafeRegex).matched,
    ).toBe(true);
    expect(
      evaluateRules([{ type: "device", device_id: OTHER_DEVICE }], msg(), compileSafeRegex).matched,
    ).toBe(false);
    expect(evaluateRules([{ type: "sim_slot", slot: 0 }], msg(), compileSafeRegex).matched).toBe(
      true,
    );
    expect(evaluateRules([{ type: "sim_slot", slot: 1 }], msg(), compileSafeRegex).matched).toBe(
      false,
    );
    expect(
      evaluateRules([{ type: "sim_slot", slot: 0 }], msg({ simSlot: null }), compileSafeRegex)
        .matched,
    ).toBe(false);
  });

  it("AND group requires every child", () => {
    const rules: StreamRule[] = [
      {
        type: "and",
        rules: [
          { type: "sender_prefix", value: "+1" },
          { type: "body_keyword", match: "any", keywords: ["otp"] },
        ],
      },
    ];
    const hit = evaluateRules(rules, msg(), compileSafeRegex);
    expect(hit.matched).toBe(true);
    expect(hit.matchedRule?.type).toBe("and");
    expect(evaluateRules(rules, msg({ body: "hello" }), compileSafeRegex).matched).toBe(false);
  });

  it("OR group returns first matching child path", () => {
    const rules: StreamRule[] = [
      {
        type: "or",
        rules: [
          { type: "sender_equals", value: "Bank" },
          { type: "body_keyword", match: "any", keywords: ["otp"] },
        ],
      },
    ];
    const hit = evaluateRules(rules, msg(), compileSafeRegex);
    expect(hit.matched).toBe(true);
    expect(hit.matchedRule).toEqual({
      path: "rules_json[0].rules[1]",
      type: "body_keyword",
    });
  });

  it("nested AND/OR", () => {
    const rules: StreamRule[] = [
      {
        type: "and",
        rules: [
          { type: "sim_slot", slot: 0 },
          {
            type: "or",
            rules: [
              { type: "sender_prefix", value: "+44" },
              { type: "body_regex", pattern: "OTP" },
            ],
          },
        ],
      },
    ];
    expect(evaluateRules(rules, msg(), compileSafeRegex).matched).toBe(true);
    expect(evaluateRules(rules, msg({ body: "x", sender: "+1" }), compileSafeRegex).matched).toBe(
      false,
    );
  });

  it("top-level array is implicit AND; empty matches all", () => {
    expect(evaluateRules([], msg(), compileSafeRegex)).toEqual({
      matched: true,
      matchedRule: null,
    });
    const prepared = prepareRules(
      [
        { type: "sender_prefix", value: "+1" },
        { type: "body_keyword", match: "any", keywords: ["otp"] },
      ],
      compileSafeRegex,
    );
    expect(evaluatePrepared(prepared, msg()).matched).toBe(true);
    expect(evaluatePrepared(prepared, msg({ body: "no" })).matched).toBe(false);
    expect(evaluatePrepared(prepared, msg()).matchedRule).toEqual({
      path: "rules_json",
      type: "and",
    });
  });

  it("bodySnippet truncates", () => {
    expect(bodySnippet("hi")).toBe("hi");
    expect(bodySnippet("x".repeat(200)).length).toBe(160);
  });
});
