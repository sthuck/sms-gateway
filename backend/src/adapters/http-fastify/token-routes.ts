import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_TOKEN_NAME_LEN } from "../../domain/auth/access-token.js";
import { TokenError } from "../../domain/auth/token-errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { requireOwnerWriteAuth } from "./auth-plugin.js";
import { sendProblem, type ProblemCode } from "./problems.js";

const createBodySchema = z
  .object({
    name: z.string().min(1).max(MAX_TOKEN_NAME_LEN),
  })
  .strict();

function clientIp(request: FastifyRequest): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  return request.ip || null;
}

function toTokenDto(token: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: token.id,
    name: token.name,
    created_at: token.createdAt.toISOString(),
    last_used_at: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    revoked_at: token.revokedAt ? token.revokedAt.toISOString() : null,
  };
}

function mapTokenError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: unknown,
  instance: string,
  infraDetail: string,
): FastifyReply | void {
  if (err instanceof TokenError) {
    return sendProblem(reply, err.code as ProblemCode, err.status, err.message, { instance });
  }
  if (isInfrastructureError(err) || err instanceof InfrastructureError) {
    request.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "owner token infra failed",
    );
    return sendProblem(reply, "service_unavailable", 503, infraDetail, {
      retryable: true,
      instance,
    });
  }
  throw err;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/tokens", { preHandler: requireOwnerWriteAuth }, async (request, reply) => {
    const create = app.authUseCases?.createOwnerAccessToken ?? null;
    if (!create) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/tokens",
      });
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Invalid request body", {
        instance: "/v1/tokens",
      });
    }
    if (parsed.data.name.includes("\u0000")) {
      return sendProblem(reply, "invalid_request", 400, "Invalid token name", {
        instance: "/v1/tokens",
      });
    }

    try {
      const result = await create.execute({
        ownerId: request.ownerId!,
        name: parsed.data.name,
        clientIp: clientIp(request),
      });
      return reply.status(201).send({
        ...toTokenDto(result.token),
        token: result.secret,
      });
    } catch (err) {
      return mapTokenError(reply, request, err, "/v1/tokens", "Failed to create token");
    }
  });

  app.get("/v1/tokens", { preHandler: requireOwnerWriteAuth }, async (request, reply) => {
    const list = app.authUseCases?.listOwnerAccessTokens ?? null;
    if (!list) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/tokens",
      });
    }
    try {
      const tokens = await list.execute({ ownerId: request.ownerId! });
      return reply.status(200).send({ tokens: tokens.map(toTokenDto) });
    } catch (err) {
      return mapTokenError(reply, request, err, "/v1/tokens", "Failed to list tokens");
    }
  });

  app.delete("/v1/tokens/:id", { preHandler: requireOwnerWriteAuth }, async (request, reply) => {
    const revoke = app.authUseCases?.revokeOwnerAccessToken ?? null;
    if (!revoke) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/tokens",
      });
    }
    const { id } = request.params as { id: string };
    try {
      await revoke.execute({
        ownerId: request.ownerId!,
        tokenId: id,
        clientIp: clientIp(request),
      });
      return reply.status(204).send();
    } catch (err) {
      return mapTokenError(reply, request, err, `/v1/tokens/${id}`, "Failed to revoke token");
    }
  });
}
