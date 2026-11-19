export { createPool, type CreatePoolOptions } from "./pool.js";
export { withOwner, type WithOwnerFn } from "./with-owner.js";
export { PgSessionRepository } from "./session-repository.js";
export { PgIdentityRepository } from "./identity-repository.js";
export { PgUserRepository } from "./user-repository.js";
export { PgDeviceAuthRepository } from "./device-repository.js";
export { PgPairingCodeRepository } from "./pairing-code-repository.js";
export { PgReplayCache } from "./pg-replay-cache.js";
export { PgPairRateLimiter } from "./pg-pair-rate-limiter.js";
export { PgIngestRateLimiter } from "./pg-ingest-rate-limiter.js";
export { PgMessageRepository } from "./message-repository.js";
export { PgStreamRepository } from "./stream-repository.js";
export { PgUserKeyRepository } from "./user-key-repository.js";
export {
  lookupDeviceForAuth,
  lookupPairingCode,
  burnPairingCode,
  type DeviceAuthRow,
  type PairingCodeRow,
} from "./device-lookups.js";
export {
  claimNonceAndSignature,
  claimReplay,
  purgeExpiredReplays,
  maybePurgeExpiredReplays,
} from "./replay-cache.js";
export {
  consumeRateLimit,
  checkPairIpAllowed,
  checkPairGlobalInvalidAllowed,
  noteInvalidPairingCode,
  rateLimitHeaders,
  purgeStaleRateLimitBuckets,
  maybePurgeStaleRateLimitBuckets,
  DEFAULT_RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  type RateLimitDecision,
} from "./rate-limit.js";
export { lookupSessionByHash, lookupUserByEmail, lookupUserIdentity } from "./lookups.js";
export { findOrProvisionUser, type ResolvedUser } from "./provision.js";
export { withDbInfra } from "./infra.js";
