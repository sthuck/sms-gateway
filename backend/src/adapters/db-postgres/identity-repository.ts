import type { Pool } from "pg";
import type { IdentityRecord } from "../../domain/auth/types.js";
import type { IdentityRepository } from "../../ports/outbound/identity-repository.js";
import { lookupUserIdentity } from "./lookups.js";
import { withOwner } from "./with-owner.js";

export class PgIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}

  findByIssuerSub(issuer: string, sub: string): Promise<IdentityRecord | null> {
    return lookupUserIdentity(this.pool, issuer, sub);
  }

  async link(ownerId: string, issuer: string, sub: string): Promise<void> {
    await withOwner(this.pool, ownerId, async (client) => {
      await client.query(
        `INSERT INTO user_identities (owner_id, issuer, sub)
         VALUES ($1, $2, $3)`,
        [ownerId, issuer, sub],
      );
    });
  }
}
