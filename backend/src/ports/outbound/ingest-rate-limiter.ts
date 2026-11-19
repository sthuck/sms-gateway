import type { RateLimitDecision } from "../../domain/device/types.js";

/**
 * Per-device ingest rate limits (request count + message volume).
 * Infra failures MUST throw `InfrastructureError`.
 */
export type IngestRateLimiter = {
  checkRequestAllowed(deviceId: string): Promise<RateLimitDecision>;
  checkMessageVolumeAllowed(deviceId: string, messageCount: number): Promise<RateLimitDecision>;
};
