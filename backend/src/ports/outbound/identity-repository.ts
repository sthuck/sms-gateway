import type { IdentityRecord } from "../../domain/auth/types.js";

/**
 * Identity (issuer, sub) → owner mapping.
 *
 * - `null` = unknown identity (domain absence).
 * - Infra failures MUST throw `InfrastructureError`.
 */
export interface IdentityRepository {
  findByIssuerSub(issuer: string, sub: string): Promise<IdentityRecord | null>;
  link(ownerId: string, issuer: string, sub: string): Promise<void>;
}
