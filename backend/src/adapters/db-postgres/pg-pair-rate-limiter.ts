import type { Pool } from "pg";
import type { RateLimitDecision } from "../../domain/device/types.js";
import type { PairRateLimiter } from "../../ports/outbound/pair-rate-limiter.js";
import {
  checkPairGlobalInvalidAllowed,
  checkPairIpAllowed,
  noteInvalidPairingCode,
  type RateLimitConfig,
} from "./rate-limit.js";

export class PgPairRateLimiter implements PairRateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly config: RateLimitConfig,
  ) {}

  checkIpAllowed(ip: string): Promise<RateLimitDecision> {
    return checkPairIpAllowed(this.pool, ip, this.config);
  }

  checkGlobalInvalidAllowed(): Promise<RateLimitDecision> {
    return checkPairGlobalInvalidAllowed(this.pool, this.config);
  }

  noteInvalidCode(ip: string): Promise<void> {
    return noteInvalidPairingCode(this.pool, ip, this.config);
  }
}
