/**
 * Nonce/signature replay cache.
 *
 * - `"replay"` = domain outcome (already claimed).
 * - Infra failures MUST throw `InfrastructureError` (never `"replay"` for errors).
 */
export type ReplayCache = {
  claimNonceAndSignature(
    identity: string,
    nonce: string,
    signature: string,
    ttlSeconds?: number,
  ): Promise<"ok" | "replay">;
};
