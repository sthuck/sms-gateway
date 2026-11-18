import {
  buildCanonicalString,
  isUuid,
  parseTimestampHeader,
} from "../../domain/device/canonical.js";
import { DeviceError } from "../../domain/device/errors.js";
import type { DeviceAuthRecord } from "../../domain/device/types.js";
import { isInfrastructureError, InfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";
import type { ReplayCache } from "../../ports/outbound/replay-cache.js";

export type ResolveDeviceAuthDeps = {
  devices: DeviceAuthRepository;
  replay: ReplayCache;
  clockSkewSeconds: number;
  replayTtlSeconds: number;
  allowedHosts: Set<string>;
  parsePublicKey: (b64url: string) => unknown | null;
  parseNonce: (value: string | undefined) => string | null;
  parseContentSha: (value: string | undefined) => string | null;
  parseSignature: (value: string | undefined) => string | null;
  sha256HexBytes: (bytes: Buffer) => string;
  verifySignature: (canonical: string, signature: string, publicKey: unknown) => boolean;
  nowSec: () => number;
};

export type ResolveDeviceAuthInput = {
  method: string;
  path: string;
  host: string | null;
  deviceIdHeader: string | undefined;
  timestampRaw: string | undefined;
  nonceHeader: string | undefined;
  contentShaHeader: string | undefined;
  signatureHeader: string | undefined;
  contentEncoding: string | string[] | undefined;
  rawBody: Buffer;
  rejectRevoked: boolean;
};

export type ResolveDeviceAuthResult = {
  device: DeviceAuthRecord;
};

/**
 * Verify device-signed request headers (docs/contracts/device-signing.md).
 * Throws DeviceError for credential/protocol failures; rethrows InfrastructureError.
 */
export class ResolveDeviceAuth {
  constructor(private readonly deps: ResolveDeviceAuthDeps) {}

  async execute(input: ResolveDeviceAuthInput): Promise<ResolveDeviceAuthResult> {
    try {
      if (input.contentEncoding) {
        throw new DeviceError(
          "invalid_request",
          400,
          "Content-Encoding is not supported on device requests",
        );
      }

      if (!input.deviceIdHeader || !isUuid(input.deviceIdHeader)) {
        throw new DeviceError("invalid_request", 400, "Missing or invalid X-Device-Id");
      }

      const host = input.host?.toLowerCase() ?? null;
      if (!host || !this.deps.allowedHosts.has(host)) {
        throw new DeviceError("invalid_request", 400, "Host is not an allowed backend host");
      }

      const nonce = this.deps.parseNonce(input.nonceHeader);
      const contentSha = this.deps.parseContentSha(input.contentShaHeader);
      const signature = this.deps.parseSignature(input.signatureHeader);

      if (!input.timestampRaw || !nonce || !contentSha || !signature) {
        throw new DeviceError("invalid_request", 400, "Missing or malformed device auth headers");
      }

      const timestampSec = parseTimestampHeader(input.timestampRaw);
      if (timestampSec === null) {
        throw new DeviceError("invalid_request", 400, "Malformed X-Timestamp");
      }

      if (input.rawBody.length > 1_048_576) {
        throw new DeviceError("payload_too_large", 413, "Request body exceeds 1 MiB");
      }

      const actualHash = this.deps.sha256HexBytes(input.rawBody);
      if (actualHash !== contentSha) {
        throw new DeviceError(
          "content_hash_mismatch",
          400,
          "X-Content-SHA256 does not match the request body",
        );
      }

      const nowSec = this.deps.nowSec();
      if (Math.abs(nowSec - timestampSec) > this.deps.clockSkewSeconds) {
        throw new DeviceError("invalid_timestamp", 401, "X-Timestamp outside allowed skew window", {
          retryable: true,
          serverTime: nowSec,
        });
      }

      // device_unknown before signature verification (contract security note).
      const device = await this.deps.devices.lookupForAuth(input.deviceIdHeader);
      if (!device) {
        throw new DeviceError("device_unknown", 401, "Unknown or deleted device");
      }

      const publicKey = this.deps.parsePublicKey(device.publicKey);
      if (!publicKey) {
        throw new DeviceError("invalid_signature", 401, "Stored public key is invalid");
      }

      const canonical = buildCanonicalString({
        method: input.method,
        path: input.path,
        query: "",
        host,
        deviceId: device.deviceId,
        timestamp: input.timestampRaw,
        contentSha256: contentSha,
        nonce,
      });

      if (!this.deps.verifySignature(canonical, signature, publicKey)) {
        throw new DeviceError("invalid_signature", 401, "Signature verification failed");
      }

      if (input.rejectRevoked && (device.status === "revoked" || device.credentialRevokedAt)) {
        throw new DeviceError(
          "device_revoked",
          403,
          "This device credential has been revoked. Pair a new device.",
        );
      }

      const claimed = await this.deps.replay.claimNonceAndSignature(
        device.deviceId,
        nonce,
        signature,
        this.deps.replayTtlSeconds,
      );
      if (claimed === "replay") {
        throw new DeviceError("replay_detected", 401, "Nonce or signature reused", {
          retryable: true,
        });
      }

      return { device };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) throw err;
      throw InfrastructureError.wrap(err, "device auth failed");
    }
  }
}
