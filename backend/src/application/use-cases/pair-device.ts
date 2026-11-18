import { displayNameFromDeviceInfo, normalizePairingCode } from "../../domain/device/pairing.js";
import { DeviceError } from "../../domain/device/errors.js";
import type { DeviceInfo, PairedDevice, RateLimitDecision } from "../../domain/device/types.js";
import { isInfrastructureError, InfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";
import type { PairingCodeRepository } from "../../ports/outbound/pairing-code-repository.js";
import type { PairRateLimiter } from "../../ports/outbound/pair-rate-limiter.js";

export type PairDeviceDeps = {
  devices: DeviceAuthRepository;
  pairingCodes: PairingCodeRepository;
  rateLimiter: PairRateLimiter;
  hashCode: (normalized: string) => string;
  isValidPublicKey: (publicKeyB64url: string) => boolean;
};

export type PairBody = {
  pairingCode: string;
  publicKey: string;
  deviceInfo: DeviceInfo;
};

export type PairDeviceInput = {
  clientIp: string;
  /**
   * Parse/validate the HTTP body. Invoked after IP rate-limit headers would
   * have been applied on main (so 400s still carry RateLimit-* headers).
   */
  parseBody: () => PairBody;
  /**
   * Proof-of-possession check (headers + replay). Invoked after code
   * normalize / public-key checks and before pairing-code lookup.
   */
  verifyProofOfPossession: (publicKey: string) => Promise<void>;
};

export type PairDeviceOk = {
  ok: true;
  device: PairedDevice;
  ownerId: string;
  ipRateLimit: RateLimitDecision;
};

export type PairDeviceErr = {
  ok: false;
  error: DeviceError;
  rateLimit?: RateLimitDecision;
  /** IP decision when available (for RateLimit-* on non-429 failures). */
  ipRateLimit?: RateLimitDecision;
};

export type PairDeviceResult = PairDeviceOk | PairDeviceErr;

export class PairDevice {
  constructor(private readonly deps: PairDeviceDeps) {}

  async execute(input: PairDeviceInput): Promise<PairDeviceResult> {
    let ipLimit: RateLimitDecision | undefined;
    try {
      ipLimit = await this.deps.rateLimiter.checkIpAllowed(input.clientIp);
      if (!ipLimit.allowed) {
        return {
          ok: false,
          rateLimit: ipLimit,
          ipRateLimit: ipLimit,
          error: new DeviceError("rate_limited", 429, "Too many pairing attempts from this IP", {
            retryable: true,
          }),
        };
      }

      const globalLimit = await this.deps.rateLimiter.checkGlobalInvalidAllowed();
      if (!globalLimit.allowed) {
        return {
          ok: false,
          rateLimit: globalLimit,
          ipRateLimit: ipLimit,
          error: new DeviceError(
            "rate_limited",
            429,
            "Too many invalid pairing attempts; try again later",
            { retryable: true },
          ),
        };
      }

      // Body parse after rate-limit checks (parity: RateLimit-* already applied).
      const body = input.parseBody();

      if (!this.deps.isValidPublicKey(body.publicKey)) {
        return {
          ok: false,
          ipRateLimit: ipLimit,
          error: new DeviceError("invalid_public_key", 400, "Public key is not a valid P-256 SPKI"),
        };
      }

      const normalized = normalizePairingCode(body.pairingCode);
      if (!normalized) {
        await this.deps.rateLimiter.noteInvalidCode(input.clientIp);
        return {
          ok: false,
          ipRateLimit: ipLimit,
          error: new DeviceError(
            "invalid_pairing_code",
            400,
            "The pairing code is expired, already used, or malformed.",
          ),
        };
      }

      await input.verifyProofOfPossession(body.publicKey);

      const codeHash = this.deps.hashCode(normalized);
      const lookedUp = await this.deps.pairingCodes.lookupByHash(codeHash);
      if (!lookedUp) {
        await this.deps.rateLimiter.noteInvalidCode(input.clientIp);
        return {
          ok: false,
          ipRateLimit: ipLimit,
          error: new DeviceError(
            "invalid_pairing_code",
            400,
            "The pairing code is expired, already used, or malformed.",
          ),
        };
      }

      const displayName = displayNameFromDeviceInfo(body.deviceInfo);
      const paired = await this.deps.devices.pairWithBurnedCode({
        ownerId: lookedUp.ownerId,
        pairingCodeId: lookedUp.pairingCodeId,
        displayName,
        publicKey: body.publicKey,
        deviceInfo: body.deviceInfo,
        clientIp: input.clientIp,
      });

      if (!paired) {
        await this.deps.rateLimiter.noteInvalidCode(input.clientIp);
        return {
          ok: false,
          ipRateLimit: ipLimit,
          error: new DeviceError(
            "invalid_pairing_code",
            400,
            "The pairing code is expired, already used, or malformed.",
          ),
        };
      }

      return {
        ok: true,
        device: paired,
        ownerId: lookedUp.ownerId,
        ipRateLimit: ipLimit,
      };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) {
        return ipLimit
          ? { ok: false, error: err, ipRateLimit: ipLimit }
          : { ok: false, error: err };
      }
      throw InfrastructureError.wrap(err, "device pair failed");
    }
  }
}
