import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_TOKEN_EXPIRES_IN_DAYS, MAX_TOKEN_NAME_LEN } from "../../domain/auth/access-token.js";
import { TokenError } from "../../domain/auth/token-errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { requireOwnerWriteAuth } from "./auth-plugin.js";
import { sendProblem, type ProblemCode } from "./problems.js";

const createBodySchema = z
  .object({
    name: z.string().min(1).max(MAX_TOKEN_NAME_LEN),
    /** Integer days until expiry, or null for no expiry. Omitted → no expiry. */
    expires_in_days: z
      .union([z.number().int().min(1).max(MAX_TOKEN_EXPIRES_IN_DAYS), z.null()])
      .optional(),
  })
  .strict();

/**
 * Client IP for audit logs. Relies on Fastify `trustProxy` (configured from
 * TRUST_PROXY); never parses X-Forwarded-For by hand.
 */
function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip?.trim();
  if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) {
    return null;
  }
  return ip;
}

function toTokenDto(token: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: token.id,
    name: token.name,
    created_at: token.createdAt.toISOString(),
    last_used_at: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    expires_at: token.expiresAt ? token.expiresAt.toISOString() : null,
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
        expiresInDays: parsed.data.expires_in_days ?? null,
        clientIp: clientIp(request),
      });
      const payload: Record<string, unknown> = {
        ...toTokenDto(result.token),
        token: result.secret,
      };
      if (result.accessHeaders && Object.keys(result.accessHeaders).length > 0) {
        payload.access_headers = result.accessHeaders;
      }
      return reply.header("Cache-Control", "no-store").status(201).send(payload);
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
