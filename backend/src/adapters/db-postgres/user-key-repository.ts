import type { Pool } from "pg";
import { InfrastructureError } from "../../domain/errors.js";
import type {
  InsertUserKeyInput,
  UserKeyRecord,
  UserKeyRepository,
} from "../../ports/outbound/user-key-repository.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

type UserKeyRow = {
  owner_id: string;
  wrapped_dek: Buffer;
  kek_id: string;
  dek_version: number;
  created_at: Date;
};

function mapRow(row: UserKeyRow): UserKeyRecord {
  return {
    ownerId: row.owner_id,
    wrappedDek: new Uint8Array(row.wrapped_dek),
    kekId: row.kek_id,
    dekVersion: row.dek_version,
    createdAt: row.created_at,
  };
}

export class PgUserKeyRepository implements UserKeyRepository {
  constructor(private readonly pool: Pool) {}

  getOrCreateLatest(
    ownerId: string,
    create: () => Promise<Omit<InsertUserKeyInput, "ownerId" | "dekVersion">>,
  ): Promise<UserKeyRecord> {
    return withDbInfra("user key get-or-create failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const existing = await client.query<UserKeyRow>(
          `SELECT owner_id, wrapped_dek, kek_id, dek_version, created_at
           FROM user_keys
           ORDER BY dek_version DESC
           LIMIT 1`,
        );
        if (existing.rows[0]) {
          return mapRow(existing.rows[0]);
        }

        let material: Omit<InsertUserKeyInput, "ownerId" | "dekVersion">;
        try {
          material = await create();
        } catch (err) {
          if (err instanceof InfrastructureError) throw err;
          throw new InfrastructureError("DEK create/wrap failed", { cause: err });
        }

        await client.query(
          `INSERT INTO user_keys (owner_id, wrapped_dek, kek_id, dek_version)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (owner_id, dek_version) DO NOTHING`,
          [ownerId, Buffer.from(material.wrappedDek), material.kekId],
        );

        const after = await client.query<UserKeyRow>(
          `SELECT owner_id, wrapped_dek, kek_id, dek_version, created_at
           FROM user_keys
           ORDER BY dek_version DESC
           LIMIT 1`,
        );
        const row = after.rows[0];
        if (!row) {
          throw new InfrastructureError("user_keys insert raced without a visible row");
        }
        return mapRow(row);
      }),
    );
  }

  getByVersion(ownerId: string, dekVersion: number): Promise<UserKeyRecord | null> {
    return withDbInfra("user key lookup failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<UserKeyRow>(
          `SELECT owner_id, wrapped_dek, kek_id, dek_version, created_at
           FROM user_keys
           WHERE dek_version = $1`,
          [dekVersion],
        );
        return rows[0] ? mapRow(rows[0]) : null;
      }),
    );
  }

  listForOwner(ownerId: string): Promise<UserKeyRecord[]> {
    return withDbInfra("user key list failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<UserKeyRow>(
          `SELECT owner_id, wrapped_dek, kek_id, dek_version, created_at
           FROM user_keys
           ORDER BY dek_version ASC`,
        );
        return rows.map(mapRow);
      }),
    );
  }

  insertVersion(input: InsertUserKeyInput): Promise<UserKeyRecord> {
    return withDbInfra("user key insert version failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const { rows } = await client.query<UserKeyRow>(
          `INSERT INTO user_keys (owner_id, wrapped_dek, kek_id, dek_version)
           VALUES ($1, $2, $3, $4)
           RETURNING owner_id, wrapped_dek, kek_id, dek_version, created_at`,
          [input.ownerId, Buffer.from(input.wrappedDek), input.kekId, input.dekVersion],
        );
        const row = rows[0];
        if (!row) {
          throw new InfrastructureError("user_keys insert returned no row");
        }
        return mapRow(row);
      }),
    );
  }

  updateWrapped(
    ownerId: string,
    dekVersion: number,
    wrappedDek: Uint8Array,
    kekId: string,
  ): Promise<void> {
    return withDbInfra("user key rewrap failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const result = await client.query(
          `UPDATE user_keys
           SET wrapped_dek = $1, kek_id = $2
           WHERE dek_version = $3`,
          [Buffer.from(wrappedDek), kekId, dekVersion],
        );
        if ((result.rowCount ?? 0) === 0) {
          throw new InfrastructureError(`user_keys row missing for dek_version ${dekVersion}`);
        }
      }),
    );
  }

  deleteAllForOwner(ownerId: string): Promise<number> {
    return withDbInfra("user key delete failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const result = await client.query(`DELETE FROM user_keys`);
        return result.rowCount ?? 0;
      }),
    );
  }
}
