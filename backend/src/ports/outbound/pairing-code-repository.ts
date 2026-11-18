import type { PairingCodeRecord } from "../../domain/device/types.js";

/**
 * Pairing-code persistence.
 *
 * - `null` from lookup = not found / expired / already used (domain absence).
 * - Infra failures MUST throw `InfrastructureError`.
 * - `burn` returns false when another caller won the race (domain outcome).
 */
export type PairingCodeRepository = {
  lookupByHash(codeHash: string): Promise<PairingCodeRecord | null>;

  insert(input: {
    ownerId: string;
    codeHash: string;
    ttlSeconds: number;
  }): Promise<{ id: string; expiresAt: Date }>;

  /**
   * Atomically burn under the owner's RLS context.
   * Returns true if this caller won the race.
   */
  burn(ownerId: string, pairingCodeId: string): Promise<boolean>;
};
