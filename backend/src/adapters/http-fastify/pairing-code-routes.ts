import type { FastifyInstance } from "fastify";
import { DeviceError } from "../../domain/device/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { requireOwnerWriteAuth } from "./auth-plugin.js";
import { mapDeviceError } from "./device-plugin.js";
import { sendProblem } from "./problems.js";

export async function pairingCodeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/pairing-codes", { preHandler: requireOwnerWriteAuth }, async (request, reply) => {
    const issue = app.deviceUseCases?.issuePairingCode ?? null;
    if (!issue || !app.dbPool || !app.deviceAuthConfig) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/pairing-codes",
      });
    }

    try {
      const result = await issue.execute({ ownerId: request.ownerId! });
      // Never log the plaintext code.
      request.log.info(
        { pairing_code_id: result.pairingCodeId, expires_at: result.expiresAt },
        "pairing code issued",
      );
      return reply.status(201).send({
        code: result.code,
        qr_payload: result.qrPayload,
        expires_at: result.expiresAt,
        ttl_seconds: result.ttlSeconds,
      });
    } catch (err) {
      if (err instanceof DeviceError && err.status === 500) {
        return sendProblem(reply, "internal_error", 500, err.message, {
          retryable: true,
          instance: "/v1/pairing-codes",
        });
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "pairing code issue failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to issue pairing code", {
          retryable: true,
          instance: "/v1/pairing-codes",
        });
      }
      mapDeviceError(reply, request, err);
    }
  });
}
