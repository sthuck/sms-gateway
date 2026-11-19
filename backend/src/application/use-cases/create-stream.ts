import { StreamError } from "../../domain/stream/errors.js";
import {
  formatRuleIssues,
  validateAiPrompt,
  validateRulesJson,
  validateStreamMode,
  validateStreamName,
} from "../../domain/stream/validate-rules.js";
import type { Stream, StreamMode, StreamRule } from "../../domain/stream/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { StreamRepository } from "../../ports/outbound/stream-repository.js";

export type CreateStreamDeps = {
  streams: StreamRepository;
};

export type CreateStreamInput = {
  ownerId: string;
  name: string;
  mode: StreamMode;
  rulesJson?: unknown;
  aiPrompt?: string | null;
};

export class CreateStream {
  constructor(private readonly deps: CreateStreamDeps) {}

  async execute(input: CreateStreamInput): Promise<Stream> {
    const nameErr = validateStreamName(input.name);
    if (nameErr) {
      throw new StreamError("invalid_request", 400, formatRuleIssues([nameErr]), {
        errors: [nameErr],
      });
    }
    const modeErr = validateStreamMode(input.mode);
    if (modeErr) {
      throw new StreamError("invalid_request", 400, formatRuleIssues([modeErr]), {
        errors: [modeErr],
      });
    }

    const rulesRaw = input.rulesJson === undefined ? [] : input.rulesJson;
    const rules = validateRulesJson(rulesRaw);
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

    try {
      return await this.deps.streams.insert({
        ownerId: input.ownerId,
        name: input.name.trim(),
        mode: input.mode,
        rulesJson: rules.value as StreamRule[],
        aiPrompt: input.aiPrompt ?? null,
      });
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream create failed");
    }
  }
}
