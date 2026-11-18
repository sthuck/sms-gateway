import type { Pool } from "pg";
import type { PairingCodeRecord } from "../../domain/device/types.js";
import type { PairingCodeRepository } from "../../ports/outbound/pairing-code-repository.js";
import { burnPairingCode, lookupPairingCode } from "./device-lookups.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

export class PgPairingCodeRepository implements PairingCodeRepository {
  constructor(private readonly pool: Pool) {}

  lookupByHash(codeHash: string): Promise<PairingCodeRecord | null> {
    return lookupPairingCode(this.pool, codeHash);
  }

  insert(input: {
    ownerId: string;
    codeHash: string;
    ttlSeconds: number;
  }): Promise<{ id: string; expiresAt: Date }> {
    return withDbInfra("pairing code insert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const inserted = await client.query<{
          id: string;
          expires_at: Date;
        }>(
          `INSERT INTO pairing_codes (owner_id, code_hash, expires_at)
             VALUES (app.current_owner_id(), $1, now() + make_interval(secs => $2))
             RETURNING id, expires_at`,
          [input.codeHash, input.ttlSeconds],
        );
        const row = inserted.rows[0]!;
        return { id: row.id, expiresAt: row.expires_at };
      }),
    );
  }

  burn(ownerId: string, pairingCodeId: string): Promise<boolean> {
    return withDbInfra("pairing code burn failed", () =>
      withOwner(this.pool, ownerId, (client) => burnPairingCode(client, pairingCodeId)),
    );
  }
}
