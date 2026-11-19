import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DeviceError } from "../../domain/device/errors.js";
import {
  DecryptionError,
  InfrastructureError,
  isDecryptionError,
  isInfrastructureError,
} from "../../domain/errors.js";
import { MessageError, MAX_PAYLOAD_BYTES } from "../../domain/message/index.js";
import { DEFAULT_MESSAGES_LIMIT } from "../../application/use-cases/list-messages.js";
import { rateLimitHeaders } from "../db-postgres/rate-limit.js";
import { requireUserAuth } from "./auth-plugin.js";
import { deviceAuthPreHandler, mapDeviceError } from "./device-plugin.js";
import { buildProblem, sendProblem, type ProblemCode } from "./problems.js";

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/messages", { preHandler: requireUserAuth }, async (request, reply) => {
    const list = app.deviceUseCases?.listMessages ?? null;
    if (!list) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/messages",
      });
    }

    const query = request.query as {
      limit?: string;
      cursor?: string;
      device_id?: string;
      sender?: string;
      received_after?: string;
      received_before?: string;
      q?: string;
    };
    const listInput: {
      ownerId: string;
      limit?: number;
      cursor?: string;
      deviceId?: string;
      sender?: string;
      receivedAfter?: string;
      receivedBefore?: string;
      q?: string;
    } = { ownerId: request.ownerId! };
    if (query.limit !== undefined) listInput.limit = Number(query.limit);
    if (query.cursor !== undefined) listInput.cursor = query.cursor;
    if (query.device_id !== undefined) listInput.deviceId = query.device_id;
    if (query.sender !== undefined) listInput.sender = query.sender;
    if (query.received_after !== undefined) listInput.receivedAfter = query.received_after;
    if (query.received_before !== undefined) listInput.receivedBefore = query.received_before;
    if (query.q !== undefined) listInput.q = query.q;

    try {
      const result = await list.execute(listInput);
      return reply.status(200).send({
        messages: result.messages.map(toOwnerMessageDto),
        next_cursor: result.nextCursor,
        limit: result.limit ?? listInput.limit ?? DEFAULT_MESSAGES_LIMIT,
      });
    } catch (err) {
      return mapOwnerMessageError(reply, request, err, "/v1/messages", "Failed to list messages");
    }
  });

  app.get("/v1/messages/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const get = app.deviceUseCases?.getMessage ?? null;
    if (!get) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/messages",
      });
    }
    const { id } = request.params as { id: string };
    try {
      const message = await get.execute({ ownerId: request.ownerId!, messageId: id });
      return reply.status(200).send(toOwnerMessageDto(message));
    } catch (err) {
      return mapOwnerMessageError(
        reply,
        request,
        err,
        `/v1/messages/${id}`,
        "Failed to get message",
      );
    }
  });

  app.delete("/v1/messages/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const del = app.deviceUseCases?.deleteMessage ?? null;
    if (!del) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/messages",
      });
    }
    const { id } = request.params as { id: string };
    try {
      await del.execute({ ownerId: request.ownerId!, messageId: id });
      return reply.status(204).send();
    } catch (err) {
      return mapOwnerMessageError(
        reply,
        request,
        err,
        `/v1/messages/${id}`,
        "Failed to delete message",
      );
    }
  });

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

function toOwnerMessageDto(message: {
  id: string;
  sender: string;
  body: string;
  receivedAt: Date;
  deviceId: string;
  simSlot: number | null;
  direction: string;
}) {
  return {
    id: message.id,
    sender: message.sender,
    body: message.body,
    received_at: message.receivedAt.toISOString(),
    device_id: message.deviceId,
    sim_slot: message.simSlot,
    direction: message.direction,
  };
}

function mapOwnerMessageError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: unknown,
  instance: string,
  infraDetail: string,
): FastifyReply | void {
  if (err instanceof MessageError) {
    const problem = buildProblem(err.code as ProblemCode, err.status, err.message, { instance });
    const body = err.errors && err.errors.length > 0 ? { ...problem, errors: err.errors } : problem;
    return reply
      .status(err.status)
      .header("content-type", "application/problem+json; charset=utf-8")
      .send(body);
  }
  if (isDecryptionError(err) || err instanceof DecryptionError) {
    request.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "owner message decrypt failed",
    );
    return sendProblem(reply, "internal_error", 500, "Failed to decrypt message body", {
      retryable: false,
      instance,
    });
  }
  if (isInfrastructureError(err) || err instanceof InfrastructureError) {
    request.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "owner message infra failed",
    );
    return sendProblem(reply, "service_unavailable", 503, infraDetail, {
      retryable: true,
      instance,
    });
  }
  throw err;
}
