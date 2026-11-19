import type { Pool } from "pg";
import type { AccessHeadersMap } from "../domain/access-headers.js";
import {
  DeleteMessage,
  GetDeviceMe,
  GetMessage,
  IngestMessageBatch,
  IssuePairingCode,
  ListDevices,
  ListMessages,
  PairDevice,
  RenameDevice,
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
  PgIngestRateLimiter,
  PgMessageRepository,
  PgPairingCodeRepository,
  PgPairRateLimiter,
  PgReplayCache,
} from "../adapters/db-postgres/index.js";
import { IdentityBodyCodec } from "../adapters/body-codec/index.js";
import { DEFAULT_INGEST_CONFIG, type IngestConfig } from "../adapters/ingest/index.js";
import { formatPhoneSender } from "../adapters/phone/index.js";
import type { BodyCodec } from "../ports/outbound/body-codec.js";
import type { QueuePublisher } from "../ports/outbound/queue-publisher.js";

export type DeviceStack = {
  config: DeviceAuthConfig | null;
  useCases: DeviceUseCases | null;
};

export type BuildDeviceStackOptions = {
  config: DeviceAuthConfig | null;
  pool: Pool | null;
  queuePublisher?: QueuePublisher | null;
  ingestConfig?: IngestConfig;
  bodyCodec?: BodyCodec;
  deviceAccessHeaders?: AccessHeadersMap | null;
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
  const ingestConfig = options.ingestConfig ?? DEFAULT_INGEST_CONFIG;
  const queuePublisher = options.queuePublisher ?? null;
  const bodyCodec = options.bodyCodec ?? new IdentityBodyCodec();
  const messages = queuePublisher !== null ? new PgMessageRepository(pool, queuePublisher) : null;

  const ingestMessageBatch =
    messages !== null
      ? new IngestMessageBatch({
          messages,
          rateLimiter: new PgIngestRateLimiter(pool, ingestConfig),
          bodyCodec,
          formatPhone: formatPhoneSender,
          defaultPhoneRegion: ingestConfig.defaultPhoneRegion,
        })
      : null;

  const useCases: DeviceUseCases = {
    issuePairingCode: new IssuePairingCode({
      pairingCodes,
      generateCode: generatePairingCode,
      normalizeCode: normalizePairingCode,
      hashCode: hashPairingCode,
      ttlSeconds: config.pairingCodeTtlSeconds,
      apiPublicUrl: config.apiPublicUrl,
      deviceAccessHeaders: options.deviceAccessHeaders ?? null,
    }),
    pairDevice: new PairDevice({
      devices,
      pairingCodes,
      rateLimiter,
      hashCode: hashPairingCode,
      isValidPublicKey: (k) => Boolean(parsePublicKeySpkiB64url(k)),
    }),
    revokeDevice: new RevokeDevice({ devices }),
    listDevices: new ListDevices({ devices }),
    renameDevice: new RenameDevice({ devices }),
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
    ingestMessageBatch,
    listMessages: messages ? new ListMessages({ messages, bodyCodec }) : null,
    getMessage: messages ? new GetMessage({ messages, bodyCodec }) : null,
    deleteMessage: messages ? new DeleteMessage({ messages }) : null,
  };

  return { config, useCases };
}
