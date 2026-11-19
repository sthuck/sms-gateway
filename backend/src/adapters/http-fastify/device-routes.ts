import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DeviceError } from "../../domain/device/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import { rateLimitHeaders } from "../db-postgres/rate-limit.js";
import { requireUserAuth } from "./auth-plugin.js";
import { deviceAuthPreHandler, mapDeviceError } from "./device-plugin.js";
import { pairProofErrorToDeviceError, verifyPairProofOfPossession } from "./pair-auth.js";
import { sendProblem, type ProblemCode } from "./problems.js";
import { listDevicesQuerySchema, sendInvalidQuery } from "./query-params.js";

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

const patchDeviceBodySchema = z
  .object({
    name: z.string().min(1).max(120),
  })
  .strict();

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/devices/pair", async (request, reply) => {
    const pool = app.dbPool;
    const config = app.deviceAuthConfig;
    const pairDevice = app.deviceUseCases?.pairDevice ?? null;
    if (!pool || !config || !pairDevice) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/devices/pair",
      });
    }

    const ip = clientIp(request);

    try {
      const result = await pairDevice.execute({
        clientIp: ip,
        parseBody: () => {
          const parsed = pairBodySchema.safeParse(request.body);
          if (!parsed.success) {
            throw new DeviceError("invalid_request", 400, "Malformed pair request body");
          }
          return {
            pairingCode: parsed.data.pairing_code,
            publicKey: parsed.data.public_key,
            deviceInfo: parsed.data.device_info,
          };
        },
        verifyProofOfPossession: async (publicKey) => {
          const proof = await verifyPairProofOfPossession({
            request,
            pool,
            config,
            publicKeyB64url: publicKey,
          });
          if (!proof.ok) {
            throw pairProofErrorToDeviceError(proof);
          }
        },
      });

      if (result.ipRateLimit) {
        applyRateLimitHeaders(reply, result.ipRateLimit);
      }

      if (!result.ok) {
        const opts: {
          instance: string;
          server_time?: number;
          retryable?: boolean;
          headers?: Record<string, string | number>;
        } = { instance: "/v1/devices/pair" };
        if (result.error.serverTime !== undefined) opts.server_time = result.error.serverTime;
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

      request.log.info(
        { device_id: result.device.deviceId, owner_id: result.ownerId },
        "device paired",
      );
      return reply.status(201).send({
        device_id: result.device.deviceId,
        name: result.device.name,
        status: result.device.status,
        paired_at: result.device.pairedAt,
      });
    } catch (err) {
      if (err instanceof DeviceError) {
        mapDeviceError(reply, request, err);
        return;
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "device pair failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to pair device", {
          retryable: true,
          instance: "/v1/devices/pair",
        });
      }
      throw err;
    }
  });

  app.get(
    "/v1/devices/me",
    { preHandler: deviceAuthPreHandler({ rejectRevoked: false }) },
    async (request, reply) => {
      const device = request.device;
      if (!device) {
        return;
      }

      const getMe = app.deviceUseCases?.getDeviceMe ?? null;
      if (!getMe) {
        return sendProblem(reply, "service_unavailable", 503, "Device auth is not configured", {
          retryable: true,
          instance: "/v1/devices/me",
        });
      }

      try {
        const row = await getMe.execute({
          ownerId: device.ownerId,
          deviceId: device.deviceId,
        });
        const body: Record<string, unknown> = {
          device_id: row.deviceId,
          name: row.name,
          status: row.status,
          paired_at: row.pairedAt,
          last_seen_at: row.lastSeenAt,
        };
        if (row.status === "revoked") {
          body.revoked_at = row.revokedAt;
        }
        return reply.send(body);
      } catch (err) {
        if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
        mapDeviceError(reply, request, err);
      }
    },
  );

  app.get("/v1/devices", { preHandler: requireUserAuth }, async (request, reply) => {
    const list = app.deviceUseCases?.listDevices ?? null;
    if (!list) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: "/v1/devices",
      });
    }

    const parsedQuery = listDevicesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return sendInvalidQuery(reply, "/v1/devices", parsedQuery);
    }
    const listInput: { ownerId: string; limit?: number } = { ownerId: request.ownerId! };
    if (parsedQuery.data.limit !== undefined) {
      listInput.limit = Number(parsedQuery.data.limit);
    }

    try {
      const result = await list.execute(listInput);
      return reply.status(200).send({
        devices: result.devices.map(toOwnerDeviceDto),
        limit: result.limit,
      });
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "device list failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to list devices", {
          retryable: true,
          instance: "/v1/devices",
        });
      }
      mapDeviceError(reply, request, err);
    }
  });

  app.patch("/v1/devices/:id", { preHandler: requireUserAuth }, async (request, reply) => {
    const params = request.params as { id: string };
    const rename = app.deviceUseCases?.renameDevice ?? null;
    if (!rename) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: `/v1/devices/${params.id}`,
      });
    }

    const parsed = patchDeviceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, "invalid_request", 400, "Malformed device body", {
        instance: `/v1/devices/${params.id}`,
      });
    }

    try {
      const device = await rename.execute({
        ownerId: request.ownerId!,
        deviceId: params.id,
        name: parsed.data.name,
      });
      return reply.status(200).send(toOwnerDeviceDto(device));
    } catch (err) {
      if (err instanceof DeviceError && err.code === "not_found") {
        return sendProblem(reply, "not_found", 404, "Device not found", {
          instance: `/v1/devices/${params.id}`,
        });
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "device rename failed",
        );
        return sendProblem(reply, "internal_error", 500, "Failed to rename device", {
          retryable: true,
          instance: `/v1/devices/${params.id}`,
        });
      }
      mapDeviceError(reply, request, err);
    }
  });

  app.post("/v1/devices/:id/revoke", { preHandler: requireUserAuth }, async (request, reply) => {
    const params = request.params as { id: string };
    const revoke = app.deviceUseCases?.revokeDevice ?? null;
    if (!revoke) {
      return sendProblem(reply, "service_unavailable", 503, "Database is not configured", {
        retryable: true,
        instance: request.url,
      });
    }

    try {
      await revoke.execute({
        ownerId: request.ownerId!,
        deviceId: params.id,
        clientIp: clientIp(request),
      });
      request.log.info({ device_id: params.id }, "device revoked");
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof DeviceError && err.code === "not_found") {
        return sendProblem(reply, "not_found", 404, "Device not found", {
          instance: `/v1/devices/${params.id}/revoke`,
        });
      }
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      mapDeviceError(reply, request, err);
    }
  });
}

function toOwnerDeviceDto(device: {
  id: string;
  name: string;
  status: "active" | "revoked";
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    created_at: device.createdAt.toISOString(),
    last_seen_at: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    revoked_at: device.revokedAt ? device.revokedAt.toISOString() : null,
  };
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
