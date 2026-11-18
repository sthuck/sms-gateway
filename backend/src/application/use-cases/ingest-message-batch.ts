import { DeviceError } from "../../domain/device/errors.js";
import type { RateLimitDecision } from "../../domain/device/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import {
  MAX_BATCH_MESSAGES,
  validateBatchItem,
  type BatchItemResult,
  type FormatPhoneSender,
} from "../../domain/message/index.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type { IngestRateLimiter } from "../../ports/outbound/ingest-rate-limiter.js";
import type { MessageRepository } from "../../ports/outbound/message-repository.js";

export type IngestMessageBatchDeps = {
  messages: MessageRepository;
  rateLimiter: IngestRateLimiter;
  bodyCodec: BodyCodec;
  formatPhone: FormatPhoneSender;
  defaultPhoneRegion: string;
};

export type IngestMessageBatchInput = {
  ownerId: string;
  deviceId: string;
  rawMessages: unknown[];
  now?: Date;
};

export type IngestMessageBatchOk = {
  ok: true;
  results: BatchItemResult[];
  rateLimit: RateLimitDecision;
};

export type IngestMessageBatchErr = {
  ok: false;
  error: DeviceError;
  rateLimit?: RateLimitDecision;
};

export type IngestMessageBatchResult = IngestMessageBatchOk | IngestMessageBatchErr;

export class IngestMessageBatch {
  constructor(private readonly deps: IngestMessageBatchDeps) {}

  async execute(input: IngestMessageBatchInput): Promise<IngestMessageBatchResult> {
    try {
      if (input.rawMessages.length === 0) {
        return {
          ok: false,
          error: new DeviceError("invalid_request", 400, "messages must be a non-empty array"),
        };
      }
      if (input.rawMessages.length > MAX_BATCH_MESSAGES) {
        return {
          ok: false,
          error: new DeviceError(
            "batch_too_large",
            413,
            `A batch may contain at most ${MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }

      const reqLimit = await this.deps.rateLimiter.checkRequestAllowed(input.deviceId);
      if (!reqLimit.allowed) {
        return {
          ok: false,
          error: new DeviceError("rate_limited", 429, "Too many requests. Wait and retry.", {
            retryable: true,
          }),
          rateLimit: reqLimit,
        };
      }

      const msgLimit = await this.deps.rateLimiter.checkMessageVolumeAllowed(
        input.deviceId,
        input.rawMessages.length,
      );
      if (!msgLimit.allowed) {
        return {
          ok: false,
          error: new DeviceError(
            "rate_limited",
            429,
            "Message volume rate limit exceeded. Wait and retry.",
            { retryable: true },
          ),
          rateLimit: msgLimit,
        };
      }

      const now = input.now ?? new Date();
      const seenIds = new Set<string>();
      const results: BatchItemResult[] = new Array(input.rawMessages.length);
      const validIndexes: number[] = [];
      const validValues: Array<{
        deviceMsgId: string;
        sender: string;
        body: string;
        receivedAt: Date;
        simSlot: number | null;
        direction: "inbound" | "outbound";
      }> = [];

      for (let i = 0; i < input.rawMessages.length; i++) {
        const validated = validateBatchItem(
          input.rawMessages[i],
          this.deps.defaultPhoneRegion,
          this.deps.formatPhone,
          now,
        );
        if (!validated.ok) {
          results[i] = {
            device_msg_id: validated.deviceMsgId,
            status: "rejected",
            error: { code: validated.code, detail: validated.detail },
          };
          continue;
        }
        if (seenIds.has(validated.value.deviceMsgId)) {
          results[i] = {
            device_msg_id: validated.value.deviceMsgId,
            status: "rejected",
            error: {
              code: "duplicate_in_batch",
              detail: "device_msg_id already appeared earlier in this batch",
            },
          };
          continue;
        }
        seenIds.add(validated.value.deviceMsgId);
        validIndexes.push(i);
        validValues.push(validated.value);
      }

      if (validValues.length > 0) {
        const encoded = validValues.map((msg) => ({
          deviceMsgId: msg.deviceMsgId,
          sender: msg.sender,
          bodyCiphertext: this.deps.bodyCodec.encode(input.ownerId, msg.body),
          receivedAt: msg.receivedAt,
          simSlot: msg.simSlot,
          direction: msg.direction,
        }));

        const upserted = await this.deps.messages.upsertBatch({
          ownerId: input.ownerId,
          deviceId: input.deviceId,
          messages: encoded,
        });

        for (let j = 0; j < upserted.length; j++) {
          const row = upserted[j]!;
          const index = validIndexes[j]!;
          results[index] = {
            device_msg_id: row.deviceMsgId,
            status: row.status,
            id: row.id,
          };
        }
      }

      return { ok: true, results: results as BatchItemResult[], rateLimit: reqLimit };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) {
        return { ok: false, error: err };
      }
      throw InfrastructureError.wrap(err, "message batch ingest failed");
    }
  }
}
