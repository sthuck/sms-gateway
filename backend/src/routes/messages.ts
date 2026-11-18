import type { FastifyInstance } from "fastify";
import { sendProblem } from "../http/problems.js";
import { deviceAuthPreHandler } from "../device/plugin.js";
import { consumeRateLimit, rateLimitHeaders } from "../device/rate-limit.js";
import {
  MAX_BATCH_MESSAGES,
  type PreparedItem,
  upsertMessagesInTx,
  validateBatchItem,
} from "../ingest/index.js";
import type { IngestConfig } from "../ingest/config.js";

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/messages:batch",
    { preHandler: deviceAuthPreHandler({ rejectRevoked: true }) },
    async (request, reply) => {
      const device = request.device;
      const pool = app.dbPool;
      const boss = app.boss;
      const ingest = app.ingestConfig;

      if (!device || !pool || !ingest) {
        return;
      }
      if (!boss) {
        return sendProblem(reply, "service_unavailable", 503, "Queue publisher is not configured", {
          retryable: true,
          instance: "/v1/messages:batch",
        });
      }

      const rawBody = request.rawBody ?? Buffer.alloc(0);
      if (rawBody.length > 1_048_576) {
        return sendProblem(reply, "payload_too_large", 413, "Request body exceeds 1 MiB", {
          instance: "/v1/messages:batch",
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return sendProblem(reply, "invalid_request", 400, "Malformed JSON body", {
          instance: "/v1/messages:batch",
        });
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return sendProblem(reply, "invalid_request", 400, "Request body must be a JSON object", {
          instance: "/v1/messages:batch",
        });
      }

      const body = parsed as Record<string, unknown>;
      // Owner/device injection in the envelope is ignored; credential wins.
      void body.owner_id;
      void body.ownerId;
      void body.device_id;
      void body.deviceId;

      if (!Object.prototype.hasOwnProperty.call(body, "messages")) {
        return sendProblem(reply, "invalid_request", 400, "messages is required", {
          instance: "/v1/messages:batch",
        });
      }
      if (!Array.isArray(body.messages)) {
        return sendProblem(reply, "invalid_request", 400, "messages must be an array", {
          instance: "/v1/messages:batch",
        });
      }
      if (body.messages.length === 0) {
        return sendProblem(reply, "invalid_request", 400, "messages must be a non-empty array", {
          instance: "/v1/messages:batch",
        });
      }
      if (body.messages.length > MAX_BATCH_MESSAGES) {
        return sendProblem(
          reply,
          "batch_too_large",
          413,
          `A batch may contain at most ${MAX_BATCH_MESSAGES} messages.`,
          { instance: "/v1/messages:batch" },
        );
      }

      const reqLimit = await consumeRateLimit(
        pool,
        `ingest:req:${device.deviceId}`,
        ingest.rateLimitPerDevice,
        ingest.rateLimitWindowSec,
      );
      applyRateLimitHeaders(reply, reqLimit);
      if (!reqLimit.allowed) {
        return sendProblem(reply, "rate_limited", 429, "Too many requests. Wait and retry.", {
          retryable: true,
          instance: "/v1/messages:batch",
          headers: {
            ...rateLimitHeaders(reqLimit),
            "Retry-After": reqLimit.retryAfterSec,
          },
        });
      }

      const msgLimit = await consumeRateLimit(
        pool,
        `ingest:msgs:${device.deviceId}`,
        ingest.messageRateLimit,
        ingest.messageRateWindowSec,
        body.messages.length,
      );
      if (!msgLimit.allowed) {
        return sendProblem(
          reply,
          "rate_limited",
          429,
          "Message volume rate limit exceeded. Wait and retry.",
          {
            retryable: true,
            instance: "/v1/messages:batch",
            headers: {
              ...rateLimitHeaders(msgLimit),
              "Retry-After": msgLimit.retryAfterSec,
            },
          },
        );
      }

      const now = new Date();
      const seenIds = new Set<string>();
      const prepared: PreparedItem[] = [];

      for (let i = 0; i < body.messages.length; i++) {
        const item = body.messages[i];
        const validated = validateBatchItem(item, ingest.defaultPhoneRegion, now);
        if (!validated.ok) {
          prepared.push({
            kind: "rejected",
            index: i,
            deviceMsgId: validated.deviceMsgId,
            code: validated.code,
            detail: validated.detail,
          });
          continue;
        }
        if (seenIds.has(validated.value.deviceMsgId)) {
          prepared.push({
            kind: "rejected",
            index: i,
            deviceMsgId: validated.value.deviceMsgId,
            code: "duplicate_in_batch",
            detail: "device_msg_id already appeared earlier in this batch",
          });
          continue;
        }
        seenIds.add(validated.value.deviceMsgId);
        prepared.push({ kind: "valid", index: i, value: validated.value });
      }

      try {
        const results = await request.withOwner(async (client) =>
          upsertMessagesInTx(boss, client, {
            ownerId: device.ownerId,
            deviceId: device.deviceId,
            items: prepared,
          }),
        );

        return reply.status(200).send({ results });
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "message batch ingest failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to ingest message batch", {
          retryable: true,
          instance: "/v1/messages:batch",
        });
      }
    },
  );
}

function applyRateLimitHeaders(
  reply: { header: (k: string, v: string | number) => unknown },
  decision: { limit: number; remaining: number; resetSec: number },
): void {
  void reply.header("RateLimit-Limit", decision.limit);
  void reply.header("RateLimit-Remaining", decision.remaining);
  void reply.header("RateLimit-Reset", decision.resetSec);
}

/** Exported for tests that build a partial ingest config. */
export type { IngestConfig };
