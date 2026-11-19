import { StreamError } from "../../domain/stream/errors.js";
import {
  bodySnippet,
  evaluatePrepared,
  prepareRules,
  type MatchedRuleRef,
} from "../../domain/stream/evaluate-rules.js";
import {
  formatRuleIssues,
  validateAiPrompt,
  validateRulesJson,
  validateStreamMode,
} from "../../domain/stream/validate-rules.js";
import type { StreamMode } from "../../domain/stream/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type { MessageRepository } from "../../ports/outbound/message-repository.js";
import type { SafeRegexCompiler } from "../../ports/outbound/safe-regex.js";

export const DEFAULT_PREVIEW_LIMIT = 500;
export const MAX_PREVIEW_LIMIT = 500;

export type PreviewStreamDeps = {
  messages: MessageRepository;
  bodyCodec: BodyCodec;
  regex: SafeRegexCompiler;
};

export type PreviewStreamInput = {
  ownerId: string;
  mode: StreamMode;
  rulesJson?: unknown;
  aiPrompt?: string | null;
  limit?: number;
};

export type PreviewMatch = {
  messageId: string;
  sender: string;
  receivedAt: Date;
  bodySnippet: string;
  matchedRule: MatchedRuleRef | null;
};

export type PreviewStreamResult = {
  matches: PreviewMatch[];
  evaluated: number;
  matched: number;
  /** Always false for ai/hybrid — only rules are evaluated in preview. */
  aiEvaluated: boolean;
  /** Present when mode is ai or hybrid. */
  note: string | null;
};

export class PreviewStream {
  constructor(private readonly deps: PreviewStreamDeps) {}

  async execute(input: PreviewStreamInput): Promise<PreviewStreamResult> {
    const modeErr = validateStreamMode(input.mode);
    if (modeErr) {
      throw new StreamError("invalid_request", 400, formatRuleIssues([modeErr]), {
        errors: [modeErr],
      });
    }

    const limit = input.limit ?? DEFAULT_PREVIEW_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_LIMIT) {
      throw new StreamError(
        "invalid_request",
        400,
        `limit must be an integer between 1 and ${MAX_PREVIEW_LIMIT}`,
        {
          errors: [
            { path: "limit", message: `must be an integer between 1 and ${MAX_PREVIEW_LIMIT}` },
          ],
        },
      );
    }

    const rulesRaw = input.rulesJson === undefined ? [] : input.rulesJson;
    const rules = validateRulesJson(rulesRaw, this.deps.regex.compile);
    if (!rules.ok) {
      throw new StreamError("invalid_request", 400, formatRuleIssues(rules.issues), {
        errors: rules.issues,
      });
    }

    const promptErr = validateAiPrompt(input.aiPrompt ?? null);
    if (promptErr) {
      throw new StreamError("invalid_request", 400, formatRuleIssues([promptErr]), {
        errors: [promptErr],
      });
    }

    const aiOnlyRulesSkipped = input.mode === "ai" || input.mode === "hybrid";
    const note = aiOnlyRulesSkipped ? "AI part not evaluated; only rules were applied" : null;

    try {
      const rows = await this.deps.messages.listRecent(input.ownerId, limit);
      const prepared = prepareRules(rules.value, this.deps.regex.compile);
      const matches: PreviewMatch[] = [];

      for (const row of rows) {
        const body = this.deps.bodyCodec.decode(input.ownerId, row.bodyCiphertext);
        const evalResult = evaluatePrepared(prepared, {
          id: row.id,
          sender: row.sender,
          body,
          deviceId: row.deviceId,
          simSlot: row.simSlot,
        });
        if (evalResult.matched) {
          matches.push({
            messageId: row.id,
            sender: row.sender,
            receivedAt: row.receivedAt,
            bodySnippet: bodySnippet(body),
            matchedRule: evalResult.matchedRule,
          });
        }
      }

      return {
        matches,
        evaluated: rows.length,
        matched: matches.length,
        aiEvaluated: false,
        note,
      };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream preview failed");
    }
  }
}
