import type { Pool } from "pg";
import type { Session } from "../../domain/auth/types.js";
import type {
  InsertSessionInput,
  SessionRepository,
} from "../../ports/outbound/session-repository.js";
import { withDbInfra } from "./infra.js";
import { lookupSessionByHash } from "./lookups.js";
import { withOwner } from "./with-owner.js";

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  insert(input: InsertSessionInput): Promise<void> {
    return withDbInfra("session insert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        await client.query(
          `INSERT INTO sessions (owner_id, session_id_hash, csrf_token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [input.ownerId, input.sessionIdHash, input.csrfTokenHash, input.expiresAt.toISOString()],
        );
      }),
    );
  }

  lookupBySessionIdHash(sessionIdHash: string): Promise<Session | null> {
    return withDbInfra("session lookup failed", () =>
      lookupSessionByHash(this.pool, sessionIdHash),
    );
  }

  revokeBySessionIdHash(ownerId: string, sessionIdHash: string): Promise<void> {
    return withDbInfra("session revoke failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        await client.query(
          `UPDATE sessions SET revoked_at = now()
           WHERE session_id_hash = $1 AND revoked_at IS NULL`,
          [sessionIdHash],
        );
      }),
    );
  }

  touch(ownerId: string, sessionRowId: string): Promise<void> {
    return withDbInfra("session touch failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        await client.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [
          sessionRowId,
        ]);
      }),
    );
  }
}
