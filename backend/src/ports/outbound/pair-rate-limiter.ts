import type { RateLimitDecision } from "../../domain/device/types.js";

/**
 * Pairing rate-limit buckets (shared across API replicas).
 *
 * - Denied / allowed decisions are domain outcomes.
 * - Infra failures MUST throw `InfrastructureError`.
 */
export type PairRateLimiter = {
  checkIpAllowed(ip: string): Promise<RateLimitDecision>;
  checkGlobalInvalidAllowed(): Promise<RateLimitDecision>;
  noteInvalidCode(ip: string): Promise<void>;
};
