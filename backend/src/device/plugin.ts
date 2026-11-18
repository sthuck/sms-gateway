import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Pool, PoolClient } from "pg";
import { withOwner } from "../db/with-owner.js";
import { sendProblem } from "../http/problems.js";
import type { DeviceAuthConfig } from "./config.js";
import { lookupDeviceForAuth } from "./lookup.js";
import { claimNonceAndSignature } from "./replay-cache.js";
import {
  buildCanonicalString,
  parseContentSha256Header,
  parseNonceHeader,
  parseSignatureHeader,
  parseTimestampHeader,
  parsePublicKeySpkiB64url,
  sha256HexBytes,
  verifyEs256P1363,
} from "./signing.js";

export type DeviceRequestContext = {
  deviceId: string;
  ownerId: string;
  status: "active" | "revoked";
  publicKey: string;
};

declare module "fastify" {
  interface FastifyInstance {
    deviceAuthConfig: DeviceAuthConfig | null;
  }

  interface FastifyRequest {
    device: DeviceRequestContext | null;
  }
}

export type DevicePluginOptions = {
  config: DeviceAuthConfig | null;
};

async function devicePluginImpl(app: FastifyInstance, opts: DevicePluginOptions): Promise<void> {
  app.decorate("deviceAuthConfig", opts.config);
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

  if (!pool || !config) {
    sendProblem(reply, "service_unavailable", 503, "Device auth is not configured", {
      retryable: true,
      instance: requestPath(request),
    });
    return;
  }

  // A user session/JWT must not satisfy device-only endpoints.
  request.auth = null;

  if (request.headers["content-encoding"]) {
    sendProblem(
      reply,
      "invalid_request",
      400,
      "Content-Encoding is not supported on device requests",
      { instance: requestPath(request) },
    );
    return;
  }

  const deviceIdHeader = headerString(request.headers["x-device-id"]);
  if (!deviceIdHeader || !isUuid(deviceIdHeader)) {
    sendProblem(reply, "invalid_request", 400, "Missing or invalid X-Device-Id", {
      instance: requestPath(request),
    });
    return;
  }

  const host = resolveHost(request);
  if (!host || !config.allowedHosts.has(host.toLowerCase())) {
    sendProblem(reply, "invalid_request", 400, "Host is not an allowed backend host", {
      instance: requestPath(request),
    });
    return;
  }

  const timestampRaw = headerString(request.headers["x-timestamp"]);
  const nonce = parseNonceHeader(headerString(request.headers["x-nonce"]));
  const contentSha = parseContentSha256Header(headerString(request.headers["x-content-sha256"]));
  const signature = parseSignatureHeader(headerString(request.headers["x-signature"]));

  if (!timestampRaw || !nonce || !contentSha || !signature) {
    sendProblem(reply, "invalid_request", 400, "Missing or malformed device auth headers", {
      instance: requestPath(request),
    });
    return;
  }

  const timestampSec = parseTimestampHeader(timestampRaw);
  if (timestampSec === null) {
    sendProblem(reply, "invalid_request", 400, "Malformed X-Timestamp", {
      instance: requestPath(request),
    });
    return;
  }

  const rawBody = request.rawBody ?? Buffer.alloc(0);
  if (rawBody.length > 1_048_576) {
    sendProblem(reply, "payload_too_large", 413, "Request body exceeds 1 MiB", {
      instance: requestPath(request),
    });
    return;
  }

  const actualHash = sha256HexBytes(rawBody);
  if (actualHash !== contentSha) {
    sendProblem(
      reply,
      "content_hash_mismatch",
      400,
      "X-Content-SHA256 does not match the request body",
      { instance: requestPath(request) },
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > config.clockSkewSeconds) {
    sendProblem(reply, "invalid_timestamp", 401, "X-Timestamp outside allowed skew window", {
      instance: requestPath(request),
      server_time: nowSec,
      retryable: true,
    });
    return;
  }

  // device_unknown before signature verification (contract security note).
  const device = await lookupDeviceForAuth(pool, deviceIdHeader);
  if (!device) {
    sendProblem(reply, "device_unknown", 401, "Unknown or deleted device", {
      instance: requestPath(request),
    });
    return;
  }

  const publicKey = parsePublicKeySpkiB64url(device.publicKey);
  if (!publicKey) {
    sendProblem(reply, "invalid_signature", 401, "Stored public key is invalid", {
      instance: requestPath(request),
    });
    return;
  }

  const pathOnly = requestPath(request);
  const canonical = buildCanonicalString({
    method: request.method,
    path: pathOnly,
    query: "",
    host,
    deviceId: device.deviceId,
    timestamp: timestampRaw,
    contentSha256: contentSha,
    nonce,
  });

  if (!verifyEs256P1363(canonical, signature, publicKey)) {
    sendProblem(reply, "invalid_signature", 401, "Signature verification failed", {
      instance: requestPath(request),
    });
    return;
  }

  if (rejectRevoked && (device.status === "revoked" || device.credentialRevokedAt)) {
    sendProblem(
      reply,
      "device_revoked",
      403,
      "This device credential has been revoked. Pair a new device.",
      { instance: pathOnly },
    );
    return;
  }

  // Atomic claim after verify — concurrent identical requests: exactly one wins.
  const claimed = await claimNonceAndSignature(
    pool,
    device.deviceId,
    nonce,
    signature,
    config.replayTtlSeconds,
  );
  if (claimed === "replay") {
    sendProblem(reply, "replay_detected", 401, "Nonce or signature reused", {
      instance: requestPath(request),
      retryable: true,
    });
    return;
  }

  bindDevice(request, pool, {
    deviceId: device.deviceId,
    ownerId: device.ownerId,
    status: device.status,
    publicKey: device.publicKey,
  });
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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
