import type { Pool } from "pg";
import {
  GetDeviceMe,
  IssuePairingCode,
  PairDevice,
  ResolveDeviceAuth,
  RevokeDevice,
} from "../application/use-cases/index.js";
import type { DeviceUseCases } from "../adapters/http-fastify/device-plugin.js";
import type { DeviceAuthConfig } from "../adapters/device-crypto/config.js";
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  parseContentSha256Header,
  parseNonceHeader,
  parsePublicKeySpkiB64url,
  parseSignatureHeader,
  sha256HexBytes,
  verifyEs256P1363,
} from "../adapters/device-crypto/index.js";
import {
  PgDeviceAuthRepository,
  PgPairingCodeRepository,
  PgPairRateLimiter,
  PgReplayCache,
} from "../adapters/db-postgres/index.js";

export type DeviceStack = {
  config: DeviceAuthConfig | null;
  useCases: DeviceUseCases | null;
};

export type BuildDeviceStackOptions = {
  config: DeviceAuthConfig | null;
  pool: Pool | null;
};

export function buildDeviceStack(options: BuildDeviceStackOptions): DeviceStack {
  const { config, pool } = options;
  if (!config || !pool) {
    return { config: config ?? null, useCases: null };
  }

  const devices = new PgDeviceAuthRepository(pool);
  const pairingCodes = new PgPairingCodeRepository(pool);
  const replay = new PgReplayCache(pool);
  const rateLimiter = new PgPairRateLimiter(pool, config.rateLimit);

  const useCases: DeviceUseCases = {
    issuePairingCode: new IssuePairingCode({
      pairingCodes,
      generateCode: generatePairingCode,
      normalizeCode: normalizePairingCode,
      hashCode: hashPairingCode,
      ttlSeconds: config.pairingCodeTtlSeconds,
      apiPublicUrl: config.apiPublicUrl,
    }),
    pairDevice: new PairDevice({
      devices,
      pairingCodes,
      rateLimiter,
      hashCode: hashPairingCode,
      isValidPublicKey: (k) => Boolean(parsePublicKeySpkiB64url(k)),
    }),
    revokeDevice: new RevokeDevice({ devices }),
    getDeviceMe: new GetDeviceMe({ devices }),
    resolveDeviceAuth: new ResolveDeviceAuth({
      devices,
      replay,
      clockSkewSeconds: config.clockSkewSeconds,
      replayTtlSeconds: config.replayTtlSeconds,
      allowedHosts: config.allowedHosts,
      parsePublicKey: parsePublicKeySpkiB64url,
      parseNonce: parseNonceHeader,
      parseContentSha: parseContentSha256Header,
      parseSignature: parseSignatureHeader,
      sha256HexBytes,
      verifySignature: (canonical, signature, publicKey) =>
        verifyEs256P1363(canonical, signature, publicKey as Parameters<typeof verifyEs256P1363>[2]),
      nowSec: () => Math.floor(Date.now() / 1000),
    }),
  };

  return { config, useCases };
}
