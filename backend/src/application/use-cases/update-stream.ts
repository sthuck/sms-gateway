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
import type {
  StreamRepository,
  UpdateStreamPatch,
} from "../../ports/outbound/stream-repository.js";
import type { SafeRegexCompiler } from "../../ports/outbound/safe-regex.js";

export type UpdateStreamDeps = {
  streams: StreamRepository;
  regex: SafeRegexCompiler;
};

export type UpdateStreamInput = {
  ownerId: string;
  streamId: string;
  name?: string;
  mode?: StreamMode;
  rulesJson?: unknown;
  aiPrompt?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UpdateStream {
  constructor(private readonly deps: UpdateStreamDeps) {}

  async execute(input: UpdateStreamInput): Promise<Stream> {
    if (!UUID_RE.test(input.streamId)) {
      throw new StreamError("invalid_request", 400, "Invalid stream id");
    }

    const patch: UpdateStreamPatch = {};
    const hasName = input.name !== undefined;
    const hasMode = input.mode !== undefined;
    const hasRules = input.rulesJson !== undefined;
    const hasPrompt = input.aiPrompt !== undefined;

    if (!hasName && !hasMode && !hasRules && !hasPrompt) {
      throw new StreamError("invalid_request", 400, "At least one field is required");
    }

    if (hasName) {
      const nameErr = validateStreamName(input.name);
      if (nameErr) {
        throw new StreamError("invalid_request", 400, formatRuleIssues([nameErr]), {
          errors: [nameErr],
        });
      }
      patch.name = (input.name as string).trim();
    }
    if (hasMode) {
      const modeErr = validateStreamMode(input.mode);
      if (modeErr) {
        throw new StreamError("invalid_request", 400, formatRuleIssues([modeErr]), {
          errors: [modeErr],
        });
      }
      patch.mode = input.mode as StreamMode;
    }
    if (hasRules) {
      const rules = validateRulesJson(input.rulesJson, this.deps.regex.compile);
      if (!rules.ok) {
        throw new StreamError("invalid_request", 400, formatRuleIssues(rules.issues), {
          errors: rules.issues,
        });
      }
      patch.rulesJson = rules.value as StreamRule[];
    }
    if (hasPrompt) {
      const promptErr = validateAiPrompt(input.aiPrompt);
      if (promptErr) {
        throw new StreamError("invalid_request", 400, formatRuleIssues([promptErr]), {
          errors: [promptErr],
        });
      }
      patch.aiPrompt = input.aiPrompt as string | null;
    }

    try {
      const updated = await this.deps.streams.update({
        ownerId: input.ownerId,
        streamId: input.streamId,
        patch,
      });
      if (!updated) {
        throw new StreamError("not_found", 404, "Stream not found");
      }
      return updated;
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream update failed");
    }
  }
}
