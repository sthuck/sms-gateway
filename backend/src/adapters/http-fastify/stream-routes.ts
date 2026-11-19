import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Stream } from "../../domain/stream/types.js";
import { STREAM_MODES } from "../../domain/stream/types.js";
import { StreamError } from "../../domain/stream/errors.js";
import {
  DecryptionError,
  InfrastructureError,
  isDecryptionError,
  isInfrastructureError,
} from "../../domain/errors.js";
import { DEFAULT_STREAM_LIST_LIMIT } from "../../application/use-cases/list-streams.js";
import { DEFAULT_STREAM_MESSAGES_LIMIT } from "../../application/use-cases/list-stream-messages.js";
import { DEFAULT_PREVIEW_LIMIT } from "../../application/use-cases/preview-stream.js";
import { requireUserAuth } from "./auth-plugin.js";
import { mapStreamError } from "./stream-plugin.js";
import { sendProblem } from "./problems.js";

const modeSchema = z.enum(STREAM_MODES);

const createBodySchema = z
  .object({
    name: z.string(),
    mode: modeSchema,
    rules_json: z.unknown().optional(),
    ai_prompt: z.string().nullable().optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: z.string().optional(),
    mode: modeSchema.optional(),
    rules_json: z.unknown().optional(),
    ai_prompt: z.string().nullable().optional(),
  })
  .strict();

const previewBodySchema = z
  .object({
    mode: modeSchema,
    rules_json: z.unknown().optional(),
    ai_prompt: z.string().nullable().optional(),
    limit: z.number().int().optional(),
  })
  .strict();

function toDto(stream: Stream) {
  return {
    id: stream.id,
    name: stream.name,
    mode: stream.mode,
    rules_json: stream.rulesJson,
    ai_prompt: stream.aiPrompt,
    version: stream.version,
    backfill_status: stream.backfillStatus,
    created_at: stream.createdAt.toISOString(),
    updated_at: stream.updatedAt.toISOString(),
  };
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/streams:preview", { preHandler: requireUserAuth }, async (request, reply) => {
    const preview = app.streamUseCases?.previewStream ?? null;
    if (!preview) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams:preview",
      });
    }

    const parsed = previewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Malformed preview body", {
        instance: "/v1/streams:preview",
      });
    }

    try {
      const previewInput: {
        ownerId: string;
        mode: (typeof STREAM_MODES)[number];
        rulesJson?: unknown;
        aiPrompt?: string | null;
        limit?: number;
      } = {
        ownerId: request.ownerId!,
        mode: parsed.data.mode,
      };
      if (parsed.data.rules_json !== undefined) previewInput.rulesJson = parsed.data.rules_json;
      if (parsed.data.ai_prompt !== undefined) previewInput.aiPrompt = parsed.data.ai_prompt;
      if (parsed.data.limit !== undefined) previewInput.limit = parsed.data.limit;

      const result = await preview.execute(previewInput);
      return reply.status(200).send({
        matches: result.matches.map((m) => ({
          message_id: m.messageId,
          sender: m.sender,
          received_at: m.receivedAt.toISOString(),
          body_snippet: m.bodySnippet,
          matched_rule: m.matchedRule
            ? { path: m.matchedRule.path, type: m.matchedRule.type }
            : null,
        })),
        evaluated: result.evaluated,
        matched: result.matched,
        ai_evaluated: result.aiEvaluated,
        note: result.note,
        limit: previewInput.limit ?? DEFAULT_PREVIEW_LIMIT,
      });
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isDecryptionError(err) || err instanceof DecryptionError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream preview decrypt failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to decrypt message body", {
          retryable: false,
          instance: "/v1/streams:preview",
        });
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream preview failed",
        );
        return sendProblem(reply, "service_unavailable", 503, "Failed to preview stream", {
          retryable: true,
          instance: "/v1/streams:preview",
        });
      }
      throw err;
    }
  });

  app.get("/v1/streams", { preHandler: requireUserAuth }, async (request, reply) => {
    const list = app.streamUseCases?.listStreams ?? null;
    if (!list) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }

    const rawLimit = (request.query as { limit?: string }).limit;
    const listInput: { ownerId: string; limit?: number } = { ownerId: request.ownerId! };
    if (rawLimit !== undefined) {
      listInput.limit = Number(rawLimit);
    }

    try {
      const streams = await list.execute(listInput);
      return reply.status(200).send({
        streams: streams.map(toDto),
        limit: listInput.limit ?? DEFAULT_STREAM_LIST_LIMIT,
      });
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream list failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to list streams", {
          retryable: true,
          instance: "/v1/streams",
        });
      }
      throw err;
    }
  });

  app.post("/v1/streams", { preHandler: requireUserAuth }, async (request, reply) => {
    const create = app.streamUseCases?.createStream ?? null;
    if (!create) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Malformed stream body", {
        instance: "/v1/streams",
      });
    }

    try {
      const createInput: {
        ownerId: string;
        name: string;
        mode: (typeof STREAM_MODES)[number];
        rulesJson?: unknown;
        aiPrompt?: string | null;
      } = {
        ownerId: request.ownerId!,
        name: parsed.data.name,
        mode: parsed.data.mode,
      };
      if (parsed.data.rules_json !== undefined) createInput.rulesJson = parsed.data.rules_json;
      if (parsed.data.ai_prompt !== undefined) createInput.aiPrompt = parsed.data.ai_prompt;
      const stream = await create.execute(createInput);
      return reply.status(201).send(toDto(stream));
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream create failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to create stream", {
          retryable: true,
          instance: "/v1/streams",
        });
      }
      throw err;
    }
  });

  app.get("/v1/streams/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const get = app.streamUseCases?.getStream ?? null;
    if (!get) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }
    const { id } = request.params as { id: string };
    try {
      const stream = await get.execute({ ownerId: request.ownerId!, streamId: id });
      return reply.status(200).send(toDto(stream));
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream get failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to get stream", {
          retryable: true,
          instance: `/v1/streams/${id}`,
        });
      }
      throw err;
    }
  });

  app.patch("/v1/streams/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const update = app.streamUseCases?.updateStream ?? null;
    if (!update) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }
    const { id } = request.params as { id: string };
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Malformed stream body", {
        instance: `/v1/streams/${id}`,
      });
    }

    try {
      const updateInput: {
        ownerId: string;
        streamId: string;
        name?: string;
        mode?: (typeof STREAM_MODES)[number];
        rulesJson?: unknown;
        aiPrompt?: string | null;
      } = {
        ownerId: request.ownerId!,
        streamId: id,
      };
      if (parsed.data.name !== undefined) updateInput.name = parsed.data.name;
      if (parsed.data.mode !== undefined) updateInput.mode = parsed.data.mode;
      if (parsed.data.rules_json !== undefined) updateInput.rulesJson = parsed.data.rules_json;
      if (parsed.data.ai_prompt !== undefined) updateInput.aiPrompt = parsed.data.ai_prompt;
      const stream = await update.execute(updateInput);
      return reply.status(200).send(toDto(stream));
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream update failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to update stream", {
          retryable: true,
          instance: `/v1/streams/${id}`,
        });
      }
      throw err;
    }
  });

  app.delete("/v1/streams/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const del = app.streamUseCases?.deleteStream ?? null;
    if (!del) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }
    const { id } = request.params as { id: string };
    try {
      await del.execute({ ownerId: request.ownerId!, streamId: id });
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream delete failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to delete stream", {
          retryable: true,
          instance: `/v1/streams/${id}`,
        });
      }
      throw err;
    }
  });

  app.get("/v1/streams/:id/messages", { preHandler: requireUserAuth }, async (request, reply) => {
    const listMessages = app.streamUseCases?.listStreamMessages ?? null;
    if (!listMessages) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/streams",
      });
    }
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string; cursor?: string };
    const listInput: {
      ownerId: string;
      streamId: string;
      limit?: number;
      cursor?: string;
    } = {
      ownerId: request.ownerId!,
      streamId: id,
    };
    if (query.limit !== undefined) listInput.limit = Number(query.limit);
    if (query.cursor !== undefined) listInput.cursor = query.cursor;

    try {
      const result = await listMessages.execute(listInput);
      return reply.status(200).send({
        messages: result.messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          body: m.body,
          received_at: m.receivedAt.toISOString(),
          device_id: m.deviceId,
          sim_slot: m.simSlot,
          direction: m.direction,
          matched_by: m.matchedBy,
          confidence: m.confidence,
          stream_version: m.streamVersion,
        })),
        next_cursor: result.nextCursor,
        limit: result.limit ?? listInput.limit ?? DEFAULT_STREAM_MESSAGES_LIMIT,
      });
    } catch (err) {
      if (err instanceof StreamError) {
        return mapStreamError(reply, request, err);
      }
      if (isDecryptionError(err) || err instanceof DecryptionError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream messages decrypt failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to decrypt message body", {
          retryable: false,
          instance: `/v1/streams/${id}/messages`,
        });
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "stream messages list failed",
        );
        return sendProblem(reply, "service_unavailable", 503, "Failed to list stream messages", {
          retryable: true,
          instance: `/v1/streams/${id}/messages`,
        });
      }
      throw err;
    }
  });
}
