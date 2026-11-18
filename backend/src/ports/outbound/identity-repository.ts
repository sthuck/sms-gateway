import type { IdentityRecord } from "../../domain/auth/types.js";

export interface IdentityRepository {
  findByIssuerSub(issuer: string, sub: string): Promise<IdentityRecord | null>;
  link(ownerId: string, issuer: string, sub: string): Promise<void>;
}
