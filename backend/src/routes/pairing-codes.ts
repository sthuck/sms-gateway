import type { FastifyInstance } from "fastify";
import { requireUserAuth } from "../auth/plugin.js";
import { sendProblem } from "../http/problems.js";
import {
  formatPairingQrPayload,
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
} from "../device/pairing-code.js";

export async function pairingCodeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/pairing-codes", { preHandler: requireUserAuth }, async (request, reply) => {
    const pool = app.dbPool;
    const deviceConfig = app.deviceAuthConfig;
    if (!pool || !deviceConfig) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/pairing-codes",
      });
    }

    const code = generatePairingCode();
    const normalized = normalizePairingCode(code);
    if (!normalized) {
      return sendProblem(reply, "internal_error", 500, "Failed to generate pairing code", {
        retryable: true,
        instance: "/v1/pairing-codes",
      });
    }
    const codeHash = hashPairingCode(normalized);
    const ttl = deviceConfig.pairingCodeTtlSeconds;

    try {
      const row = await request.withOwner(async (client) => {
        const inserted = await client.query<{
          id: string;
          expires_at: Date;
        }>(
          `INSERT INTO pairing_codes (owner_id, code_hash, expires_at)
             VALUES (app.current_owner_id(), $1, now() + make_interval(secs => $2))
             RETURNING id, expires_at`,
          [codeHash, ttl],
        );
        return inserted.rows[0]!;
      });

      const expiresAt = row.expires_at.toISOString();
      const qrPayload = formatPairingQrPayload(code, deviceConfig.apiPublicUrl);

      // Never log the plaintext code.
      request.log.info({ pairing_code_id: row.id, expires_at: expiresAt }, "pairing code issued");

      return reply.status(201).send({
        code,
        qr_payload: qrPayload,
        expires_at: expiresAt,
        ttl_seconds: ttl,
      });
    } catch (err) {
      request.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "pairing code issue failed",
      );
      return sendProblem(reply, "internal_error", 500, "Failed to issue pairing code", {
        retryable: true,
        instance: "/v1/pairing-codes",
      });
    }
  });
}
