import type { FastifyInstance } from "fastify";
import { DeviceError } from "../../domain/device/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { MAX_PAYLOAD_BYTES } from "../../domain/message/index.js";
import { rateLimitHeaders } from "../db-postgres/rate-limit.js";
import { deviceAuthPreHandler, mapDeviceError } from "./device-plugin.js";
import { sendProblem, type ProblemCode } from "./problems.js";

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/messages:batch",
    { preHandler: deviceAuthPreHandler({ rejectRevoked: true }) },
    async (request, reply) => {
      const device = request.device;
      const ingest = app.deviceUseCases?.ingestMessageBatch ?? null;

      if (!device) {
        return;
      }
      if (!ingest) {
        return sendProblem(reply, "service_unavailable", 503, "Queue publisher is not configured", {
          retryable: true,
          instance: "/v1/messages:batch",
        });
      }

      const rawBody = request.rawBody ?? Buffer.alloc(0);
      if (rawBody.length > MAX_PAYLOAD_BYTES) {
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

      try {
        const result = await ingest.execute({
          ownerId: device.ownerId,
          deviceId: device.deviceId,
          rawMessages: body.messages,
        });

        if (result.rateLimit) {
          applyRateLimitHeaders(reply, result.rateLimit);
        }

        if (!result.ok) {
          const opts: {
            instance: string;
            retryable?: boolean;
            headers?: Record<string, string | number>;
          } = { instance: "/v1/messages:batch" };
          if (result.error.retryable) opts.retryable = true;
          if (result.rateLimit && result.error.code === "rate_limited") {
            opts.headers = {
              ...rateLimitHeaders(result.rateLimit),
              "Retry-After": result.rateLimit.retryAfterSec,
            };
          }
          return sendProblem(
            reply,
            result.error.code as ProblemCode,
            result.error.status,
            result.error.message,
            opts,
          );
        }

        return reply.status(200).send({ results: result.results });
      } catch (err) {
        if (err instanceof DeviceError) {
          mapDeviceError(reply, request, err);
          return;
        }
        if (isInfrastructureError(err) || err instanceof InfrastructureError) {
          request.log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "message batch ingest failed",
          );
          return sendProblem(reply, "internal_error", 500, "Failed to ingest message batch", {
            retryable: true,
            instance: "/v1/messages:batch",
          });
        }
        throw err;
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
