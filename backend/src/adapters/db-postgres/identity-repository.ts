import type { Pool } from "pg";
import type { IdentityRecord } from "../../domain/auth/types.js";
import type { IdentityRepository } from "../../ports/outbound/identity-repository.js";
import { withDbInfra } from "./infra.js";
import { lookupUserIdentity } from "./lookups.js";
import { withOwner } from "./with-owner.js";

export class PgIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}

  findByIssuerSub(issuer: string, sub: string): Promise<IdentityRecord | null> {
    return withDbInfra("identity lookup failed", () => lookupUserIdentity(this.pool, issuer, sub));
  }

  link(ownerId: string, issuer: string, sub: string): Promise<void> {
    return withDbInfra("identity link failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        await client.query(
          `INSERT INTO user_identities (owner_id, issuer, sub)
           VALUES ($1, $2, $3)`,
          [ownerId, issuer, sub],
        );
      }),
    );
  }
}
