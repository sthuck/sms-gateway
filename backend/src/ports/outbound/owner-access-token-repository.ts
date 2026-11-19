import type { OwnerAccessToken, OwnerAccessTokenLookup } from "../../domain/auth/access-token.js";

export type InsertOwnerAccessTokenInput = {
  id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
};

/**
 * Owner PAT persistence.
 *
 * - Lookup-by-id is SECURITY DEFINER (no owner GUC yet) and returns revoked
 *   rows so callers can constant-time compare then reject uniformly.
 * - List/create/revoke run under `withOwner` (RLS).
 * - Infra failures MUST throw `InfrastructureError`.
 */
export interface OwnerAccessTokenRepository {
  insert(input: InsertOwnerAccessTokenInput): Promise<void>;
  list(ownerId: string): Promise<OwnerAccessToken[]>;
  /**
   * Idempotent revoke under RLS.
   * - `missing`: no row for this owner (→ HTTP 404)
   * - `revoked`: newly set revoked_at (→ audit)
   * - `already_revoked`: was already revoked (→ 204, no new audit)
   */
  revoke(ownerId: string, tokenId: string): Promise<"missing" | "revoked" | "already_revoked">;
  /** Pre-owner lookup by primary key (includes hash + revoked_at). */
  lookupById(tokenId: string): Promise<OwnerAccessTokenLookup | null>;
  /**
   * Best-effort last_used_at touch. Callers must not fail reads if this throws;
   * throttle in the use case / auth layer.
   */
  touchLastUsed(ownerId: string, tokenId: string): Promise<void>;
}
