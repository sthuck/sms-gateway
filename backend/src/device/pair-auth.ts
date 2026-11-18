import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { DeviceAuthConfig } from "./config.js";
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
import { headerString, requestPath, resolveHost } from "./plugin.js";

export type PairSignatureOk = {
  ok: true;
  host: string;
  nonce: string;
  signature: string;
  contentSha: string;
  replayIdentity: string;
};

export type PairSignatureErr = {
  ok: false;
  code:
    | "invalid_request"
    | "content_hash_mismatch"
    | "invalid_timestamp"
    | "invalid_public_key"
    | "invalid_signature"
    | "replay_detected"
    | "payload_too_large";
  status: number;
  detail: string;
  server_time?: number;
};

/**
 * Proof-of-possession checks for POST /v1/devices/pair.
 * Canonical DEVICE_ID is empty; replay identity is SHA-256 of SPKI bytes.
 */
export async function verifyPairProofOfPossession(args: {
  request: FastifyRequest;
  pool: Pool;
  config: DeviceAuthConfig;
  publicKeyB64url: string;
}): Promise<PairSignatureOk | PairSignatureErr> {
  const { request, pool, config, publicKeyB64url } = args;

  if (request.headers["content-encoding"]) {
    return {
      ok: false,
      code: "invalid_request",
      status: 400,
      detail: "Content-Encoding is not supported on device requests",
    };
  }

  const host = resolveHost(request);
  if (!host || !config.allowedHosts.has(host.toLowerCase())) {
    return {
      ok: false,
      code: "invalid_request",
      status: 400,
      detail: "Host is not an allowed backend host",
    };
  }

  const timestampRaw = headerString(request.headers["x-timestamp"]);
  const nonce = parseNonceHeader(headerString(request.headers["x-nonce"]));
  const contentSha = parseContentSha256Header(headerString(request.headers["x-content-sha256"]));
  const signature = parseSignatureHeader(headerString(request.headers["x-signature"]));

  if (!timestampRaw || !nonce || !contentSha || !signature) {
    return {
      ok: false,
      code: "invalid_request",
      status: 400,
      detail: "Missing or malformed device auth headers",
    };
  }

  const timestampSec = parseTimestampHeader(timestampRaw);
  if (timestampSec === null) {
    return {
      ok: false,
      code: "invalid_request",
      status: 400,
      detail: "Malformed X-Timestamp",
    };
  }

  const rawBody = request.rawBody ?? Buffer.alloc(0);
  if (rawBody.length > 1_048_576) {
    return {
      ok: false,
      code: "payload_too_large",
      status: 413,
      detail: "Request body exceeds 1 MiB",
    };
  }

  const actualHash = sha256HexBytes(rawBody);
  if (actualHash !== contentSha) {
    return {
      ok: false,
      code: "content_hash_mismatch",
      status: 400,
      detail: "X-Content-SHA256 does not match the request body",
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > config.clockSkewSeconds) {
    return {
      ok: false,
      code: "invalid_timestamp",
      status: 401,
      detail: "X-Timestamp outside allowed skew window",
      server_time: nowSec,
    };
  }

  const publicKey = parsePublicKeySpkiB64url(publicKeyB64url);
  if (!publicKey) {
    return {
      ok: false,
      code: "invalid_public_key",
      status: 400,
      detail: "Public key is not a valid P-256 SPKI",
    };
  }

  const spkiDer = Buffer.from(publicKeyB64url, "base64url");
  const replayIdentity = sha256HexBytes(spkiDer);

  const canonical = buildCanonicalString({
    method: request.method,
    path: requestPath(request),
    query: "",
    host,
    deviceId: "",
    timestamp: timestampRaw,
    contentSha256: contentSha,
    nonce,
  });

  if (!verifyEs256P1363(canonical, signature, publicKey)) {
    return {
      ok: false,
      code: "invalid_signature",
      status: 401,
      detail: "Signature verification failed",
    };
  }

  const claimed = await claimNonceAndSignature(
    pool,
    replayIdentity,
    nonce,
    signature,
    config.replayTtlSeconds,
  );
  if (claimed === "replay") {
    return {
      ok: false,
      code: "replay_detected",
      status: 401,
      detail: "Nonce or signature reused",
    };
  }

  return {
    ok: true,
    host,
    nonce,
    signature,
    contentSha,
    replayIdentity,
  };
}
