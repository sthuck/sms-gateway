import type { Pool } from "pg";
import type { OwnerAccessToken, OwnerAccessTokenLookup } from "../../domain/auth/access-token.js";
import type {
  InsertOwnerAccessTokenInput,
  OwnerAccessTokenRepository,
} from "../../ports/outbound/owner-access-token-repository.js";
import { withDbInfra } from "./infra.js";
import { lookupOwnerAccessTokenById } from "./lookups.js";
import { withOwner } from "./with-owner.js";

type TokenRow = {
  id: string;
  owner_id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

export class PgOwnerAccessTokenRepository implements OwnerAccessTokenRepository {
  constructor(private readonly pool: Pool) {}

  insert(input: InsertOwnerAccessTokenInput): Promise<void> {
    return withDbInfra("owner access token insert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        await client.query(
          `INSERT INTO owner_access_tokens (id, owner_id, name, token_hash)
           VALUES ($1, $2, $3, $4)`,
          [input.id, input.ownerId, input.name, input.tokenHash],
        );
      }),
    );
  }

  list(ownerId: string): Promise<OwnerAccessToken[]> {
    return withDbInfra("owner access token list failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<TokenRow>(
          `SELECT id, owner_id, name, created_at, last_used_at, revoked_at
           FROM owner_access_tokens
           ORDER BY created_at DESC, id DESC`,
        );
        return rows.map(mapRow);
      }),
    );
  }

  revoke(ownerId: string, tokenId: string): Promise<"missing" | "revoked" | "already_revoked"> {
    return withDbInfra("owner access token revoke failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const existing = await client.query<{ id: string; revoked_at: Date | null }>(
          `SELECT id, revoked_at FROM owner_access_tokens WHERE id = $1`,
          [tokenId],
        );
        if (existing.rows.length === 0) return "missing";
        if (existing.rows[0]!.revoked_at != null) return "already_revoked";
        await client.query(
          `UPDATE owner_access_tokens SET revoked_at = now()
           WHERE id = $1 AND revoked_at IS NULL`,
          [tokenId],
        );
        return "revoked";
      }),
    );
  }

  lookupById(tokenId: string): Promise<OwnerAccessTokenLookup | null> {
    return withDbInfra("owner access token lookup failed", () =>
      lookupOwnerAccessTokenById(this.pool, tokenId),
    );
  }

  touchLastUsed(ownerId: string, tokenId: string): Promise<void> {
    return withDbInfra("owner access token touch failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        await client.query(
          `UPDATE owner_access_tokens
           SET last_used_at = now()
           WHERE id = $1
             AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
          [tokenId],
        );
      }),
    );
  }
}

function mapRow(row: TokenRow): OwnerAccessToken {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
