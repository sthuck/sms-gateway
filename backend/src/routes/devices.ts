import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUserAuth } from "../adapters/http-fastify/auth-plugin.js";
import { sendProblem } from "../adapters/http-fastify/problems.js";
import { withOwner } from "../adapters/db-postgres/with-owner.js";
import { verifyPairProofOfPossession } from "../device/pair-auth.js";
import { hashPairingCode, normalizePairingCode } from "../device/pairing-code.js";
import { burnPairingCode, lookupPairingCode } from "../device/lookup.js";
import {
  checkPairGlobalInvalidAllowed,
  checkPairIpAllowed,
  noteInvalidPairingCode,
  rateLimitHeaders,
} from "../device/rate-limit.js";
import { deviceAuthPreHandler } from "../device/plugin.js";
import { parsePublicKeySpkiB64url } from "../device/signing.js";

const deviceInfoSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    platform: z.literal("android"),
    manufacturer: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
    os_version: z.string().max(32).optional(),
    app_version: z.string().min(1).max(32),
    sdk_int: z.number().int().min(23).optional(),
  })
  .strict();

const pairBodySchema = z
  .object({
    pairing_code: z.string(),
    alg: z.literal("ES256"),
    public_key: z
      .string()
      .min(80)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    device_info: deviceInfoSchema,
  })
  .strict();

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/devices/pair", async (request, reply) => {
    const pool = app.dbPool;
    const config = app.deviceAuthConfig;
    if (!pool || !config) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/devices/pair",
      });
    }

    const ip = clientIp(request);
    const ipLimit = await checkPairIpAllowed(pool, ip, config.rateLimit);
    applyRateLimitHeaders(reply, ipLimit);
    if (!ipLimit.allowed) {
      return sendProblem(reply, "rate_limited", 429, "Too many pairing attempts from this IP", {
        retryable: true,
        instance: "/v1/devices/pair",
        headers: {
          ...rateLimitHeaders(ipLimit),
          "Retry-After": ipLimit.retryAfterSec,
        },
      });
    }

    const globalLimit = await checkPairGlobalInvalidAllowed(pool, config.rateLimit);
    if (!globalLimit.allowed) {
      return sendProblem(
        reply,
        "rate_limited",
        429,
        "Too many invalid pairing attempts; try again later",
        {
          retryable: true,
          instance: "/v1/devices/pair",
          headers: {
            ...rateLimitHeaders(globalLimit),
            "Retry-After": globalLimit.retryAfterSec,
          },
        },
      );
    }

    const parsed = pairBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Malformed pair request body", {
        instance: "/v1/devices/pair",
      });
    }

    const body = parsed.data;
    if (!parsePublicKeySpkiB64url(body.public_key)) {
      return sendProblem(reply, "invalid_public_key", 400, "Public key is not a valid P-256 SPKI", {
        instance: "/v1/devices/pair",
      });
    }

    const normalized = normalizePairingCode(body.pairing_code);
    if (!normalized) {
      await noteInvalidPairingCode(pool, ip, config.rateLimit);
      return sendProblem(
        reply,
        "invalid_pairing_code",
        400,
        "The pairing code is expired, already used, or malformed.",
        { instance: "/v1/devices/pair" },
      );
    }

    const proof = await verifyPairProofOfPossession({
      request,
      pool,
      config,
      publicKeyB64url: body.public_key,
    });
    if (!proof.ok) {
      const opts: {
        instance: string;
        server_time?: number;
        retryable?: boolean;
      } = { instance: "/v1/devices/pair" };
      if (proof.server_time !== undefined) opts.server_time = proof.server_time;
      if (proof.code === "invalid_timestamp" || proof.code === "replay_detected") {
        opts.retryable = true;
      }
      return sendProblem(reply, proof.code, proof.status, proof.detail, opts);
    }

    const codeHash = hashPairingCode(normalized);
    const lookedUp = await lookupPairingCode(pool, codeHash);
    if (!lookedUp) {
      await noteInvalidPairingCode(pool, ip, config.rateLimit);
      return sendProblem(
        reply,
        "invalid_pairing_code",
        400,
        "The pairing code is expired, already used, or malformed.",
        { instance: "/v1/devices/pair" },
      );
    }

    const fromParts = [body.device_info.manufacturer, body.device_info.model]
      .filter(Boolean)
      .join(" ");
    const displayName = body.device_info.name ?? (fromParts || "Android device");

    let paired: {
      device_id: string;
      name: string;
      status: "active";
      paired_at: string;
    } | null;

    try {
      paired = await withOwner(pool, lookedUp.ownerId, async (client) => {
        const burned = await burnPairingCode(client, lookedUp.pairingCodeId);
        if (!burned) {
          return null;
        }

        const device = await client.query<{
          id: string;
          name: string;
          status: string;
          created_at: Date;
        }>(
          `INSERT INTO devices (owner_id, name, platform_info, status, last_seen_at)
           VALUES (
             app.current_owner_id(),
             $1,
             $2::jsonb,
             'active',
             now()
           )
           RETURNING id, name, status, created_at`,
          [displayName, JSON.stringify(body.device_info)],
        );
        const deviceRow = device.rows[0]!;

        await client.query(
          `INSERT INTO device_credentials (owner_id, device_id, public_key)
           VALUES (app.current_owner_id(), $1, $2)`,
          [deviceRow.id, body.public_key],
        );

        await client.query(
          `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, ip)
           VALUES (app.current_owner_id(), 'device', $1, 'device.pair', $2::inet)`,
          [deviceRow.id, ip],
        );

        return {
          device_id: deviceRow.id,
          name: deviceRow.name,
          status: "active" as const,
          paired_at: deviceRow.created_at.toISOString(),
        };
      });
    } catch (err) {
      request.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "device pair failed",
      );
      return sendProblem(reply, "internal_error", 500, "Failed to pair device", {
        retryable: true,
        instance: "/v1/devices/pair",
      });
    }

    if (!paired) {
      await noteInvalidPairingCode(pool, ip, config.rateLimit);
      return sendProblem(
        reply,
        "invalid_pairing_code",
        400,
        "The pairing code is expired, already used, or malformed.",
        { instance: "/v1/devices/pair" },
      );
    }

    request.log.info({ device_id: paired.device_id, owner_id: lookedUp.ownerId }, "device paired");

    return reply.status(201).send(paired);
  });

  app.get(
    "/v1/devices/me",
    { preHandler: deviceAuthPreHandler({ rejectRevoked: false }) },
    async (request, reply) => {
      const device = request.device;
      if (!device) {
        return;
      }

      const row = await request.withOwner(async (client) => {
        await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [
          device.deviceId,
        ]);
        const { rows } = await client.query<{
          id: string;
          name: string;
          status: "active" | "revoked";
          created_at: Date;
          last_seen_at: Date | null;
          revoked_at: Date | null;
        }>(
          `SELECT d.id, d.name, d.status, d.created_at, d.last_seen_at, dc.revoked_at
           FROM devices d
           JOIN device_credentials dc ON dc.device_id = d.id
           WHERE d.id = $1`,
          [device.deviceId],
        );
        return rows[0] ?? null;
      });

      if (!row) {
        return sendProblem(reply, "device_unknown", 401, "Unknown or deleted device", {
          instance: "/v1/devices/me",
        });
      }

      const body: Record<string, unknown> = {
        device_id: row.id,
        name: row.name,
        status: row.status,
        paired_at: row.created_at.toISOString(),
        last_seen_at: (row.last_seen_at ?? new Date()).toISOString(),
      };
      if (row.status === "revoked") {
        body.revoked_at = row.revoked_at ? row.revoked_at.toISOString() : null;
      }

      return reply.send(body);
    },
  );

  app.post("/v1/devices/:id/revoke", { preHandler: requireUserAuth }, async (request, reply) => {
    const params = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) {
      return sendProblem(reply, "invalid_request", 400, "Invalid device id", {
        instance: request.url,
      });
    }

    const ip = clientIp(request);
    const revoked = await request.withOwner(async (client) => {
      const exists = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM devices WHERE id = $1`,
        [params.id],
      );
      if (!exists.rows[0]) return "missing" as const;

      await client.query(`UPDATE devices SET status = 'revoked' WHERE id = $1`, [params.id]);
      await client.query(
        `UPDATE device_credentials
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE device_id = $1`,
        [params.id],
      );
      await client.query(
        `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, ip)
           VALUES (app.current_owner_id(), 'user', app.current_owner_id(), 'device.revoke', $1::inet)`,
        [ip],
      );
      return "ok" as const;
    });

    if (revoked === "missing") {
      return sendProblem(reply, "not_found", 404, "Device not found", {
        instance: `/v1/devices/${params.id}/revoke`,
      });
    }

    request.log.info({ device_id: params.id }, "device revoked");
    return reply.status(204).send();
  });
}

/**
 * Client IP for rate limits and audit. Relies on Fastify `trustProxy`
 * (configured from TRUST_PROXY); never parses X-Forwarded-For by hand.
 */
function clientIp(request: FastifyRequest): string {
  const ip = request.ip || "127.0.0.1";
  // Guard audit_log inet cast against anything unexpected.
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) {
    return "127.0.0.1";
  }
  return ip;
}

function applyRateLimitHeaders(
  reply: { header: (k: string, v: string | number) => unknown },
  decision: { limit: number; remaining: number; resetSec: number },
): void {
  void reply.header("RateLimit-Limit", decision.limit);
  void reply.header("RateLimit-Remaining", decision.remaining);
  void reply.header("RateLimit-Reset", decision.resetSec);
}
