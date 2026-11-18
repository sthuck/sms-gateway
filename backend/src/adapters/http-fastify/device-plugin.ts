import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Pool, PoolClient } from "pg";
import type {
  GetDeviceMe,
  IssuePairingCode,
  PairDevice,
  ResolveDeviceAuth,
  RevokeDevice,
} from "../../application/use-cases/index.js";
import { DeviceError } from "../../domain/device/errors.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthConfig } from "../device-crypto/config.js";
import { withOwner } from "../db-postgres/with-owner.js";
import { sendProblem, type ProblemCode } from "./problems.js";

export type DeviceRequestContext = {
  deviceId: string;
  ownerId: string;
  status: "active" | "revoked";
  publicKey: string;
};

export type DeviceUseCases = {
  issuePairingCode: IssuePairingCode | null;
  pairDevice: PairDevice | null;
  revokeDevice: RevokeDevice | null;
  getDeviceMe: GetDeviceMe | null;
  resolveDeviceAuth: ResolveDeviceAuth | null;
};

declare module "fastify" {
  interface FastifyInstance {
    deviceAuthConfig: DeviceAuthConfig | null;
    deviceUseCases: DeviceUseCases | null;
  }

  interface FastifyRequest {
    device: DeviceRequestContext | null;
  }
}

export type DevicePluginOptions = {
  config: DeviceAuthConfig | null;
  useCases?: DeviceUseCases | null | undefined;
};

async function devicePluginImpl(app: FastifyInstance, opts: DevicePluginOptions): Promise<void> {
  app.decorate("deviceAuthConfig", opts.config);
  app.decorate("deviceUseCases", opts.useCases ?? null);
  app.decorateRequest("device", null);

  app.addHook("onRequest", async (request) => {
    request.device = null;
  });
}

export const devicePlugin = fp(devicePluginImpl, {
  name: "sms-gateway-device-auth",
});

export type RequireDeviceAuthOptions = {
  /**
   * When true (default for write/ingestion routes), revoked devices get
   * `403 device_revoked`. `GET /v1/devices/me` sets this to false so a
   * revoked device can still learn its status after a valid signature.
   */
  rejectRevoked?: boolean;
};

/**
 * Verify device-signed request headers per docs/contracts/device-signing.md.
 * On success binds `request.device`, `request.ownerId`, and `request.withOwner`.
 *
 * User session/JWT alone is never accepted here.
 */
export async function requireDeviceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RequireDeviceAuthOptions = {},
): Promise<void> {
  const rejectRevoked = options.rejectRevoked !== false;
  const app = request.server;
  const pool = app.dbPool;
  const config = app.deviceAuthConfig;
  const resolve = app.deviceUseCases?.resolveDeviceAuth ?? null;

  if (!pool || !config || !resolve) {
    sendProblem(reply, "service_unavailable", 503, "Device auth is not configured", {
      retryable: true,
      instance: requestPath(request),
    });
    return;
  }

  // A user session/JWT must not satisfy device-only endpoints.
  request.auth = null;

  try {
    const result = await resolve.execute({
      method: request.method,
      path: requestPath(request),
      host: resolveHost(request),
      deviceIdHeader: headerString(request.headers["x-device-id"]),
      timestampRaw: headerString(request.headers["x-timestamp"]),
      nonceHeader: headerString(request.headers["x-nonce"]),
      contentShaHeader: headerString(request.headers["x-content-sha256"]),
      signatureHeader: headerString(request.headers["x-signature"]),
      contentEncoding: request.headers["content-encoding"],
      rawBody: request.rawBody ?? Buffer.alloc(0),
      rejectRevoked,
    });

    bindDevice(request, pool, {
      deviceId: result.device.deviceId,
      ownerId: result.device.ownerId,
      status: result.device.status,
      publicKey: result.device.publicKey,
    });
  } catch (err) {
    mapDeviceError(reply, request, err);
  }
}

export function mapDeviceError(reply: FastifyReply, request: FastifyRequest, err: unknown): void {
  // Infra / unknown non-DeviceError must reach the global handler → 500 (STH-46).
  if (
    err instanceof InfrastructureError ||
    isInfrastructureError(err) ||
    !(err instanceof DeviceError)
  ) {
    throw err;
  }
  const opts: {
    instance: string;
    server_time?: number;
    retryable?: boolean;
  } = { instance: requestPath(request) };
  if (err.serverTime !== undefined) opts.server_time = err.serverTime;
  if (err.retryable) opts.retryable = true;
  sendProblem(reply, err.code as ProblemCode, err.status, err.message, opts);
}

function bindDevice(request: FastifyRequest, pool: Pool, device: DeviceRequestContext): void {
  request.device = device;
  request.ownerId = device.ownerId;
  request.withOwner = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withOwner(pool, device.ownerId, fn);
}

/**
 * Guard documenting that device-only routes ignore user credentials.
 * Cleared again inside requireDeviceAuth; exported for route groups / tests.
 */
export async function rejectUserCredentialsOnDeviceRoute(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  request.auth = null;
}

export function requestPath(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? request.url;
}

export function resolveHost(request: FastifyRequest): string | null {
  const raw = headerString(request.headers.host);
  if (!raw) return null;
  return raw.toLowerCase();
}

export function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Factory for Fastify preHandler arrays on device-authenticated routes. */
export function deviceAuthPreHandler(
  options: RequireDeviceAuthOptions = {},
): Array<(request: FastifyRequest, reply: FastifyReply) => Promise<void>> {
  return [
    rejectUserCredentialsOnDeviceRoute,
    (request, reply) => requireDeviceAuth(request, reply, options),
  ];
}
