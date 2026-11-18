import type { Pool } from "pg";
import type { RateLimitDecision } from "../../domain/device/types.js";
import type { IngestRateLimiter } from "../../ports/outbound/ingest-rate-limiter.js";
import type { IngestConfig } from "../ingest/config.js";
import { consumeRateLimit } from "./rate-limit.js";

export class PgIngestRateLimiter implements IngestRateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly config: IngestConfig,
  ) {}

  checkRequestAllowed(deviceId: string): Promise<RateLimitDecision> {
    return consumeRateLimit(
      this.pool,
      `ingest:req:${deviceId}`,
      this.config.rateLimitPerDevice,
      this.config.rateLimitWindowSec,
    );
  }

  checkMessageVolumeAllowed(deviceId: string, messageCount: number): Promise<RateLimitDecision> {
    return consumeRateLimit(
      this.pool,
      `ingest:msgs:${deviceId}`,
      this.config.messageRateLimit,
      this.config.messageRateWindowSec,
      messageCount,
    );
  }
}
