import type { Pool } from "pg";
import type { User } from "../../domain/auth/types.js";
import type {
  CreateUserInput,
  LinkIdentityAndUpdateInput,
  UpdateAuthProfileInput,
  UserByEmail,
  UserRepository,
} from "../../ports/outbound/user-repository.js";
import { withDbInfra } from "./infra.js";
import { lookupUserByEmail } from "./lookups.js";
import { withOwner } from "./with-owner.js";

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  findById(ownerId: string, userId: string): Promise<User | null> {
    return withDbInfra("user findById failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          email: string;
          mfa_enrolled: boolean;
          display_name: string | null;
          last_auth_method: string | null;
        }>(
          `SELECT id, email, mfa_enrolled, display_name, last_auth_method
           FROM users WHERE id = $1`,
          [userId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          email: row.email,
          mfaEnrolled: row.mfa_enrolled,
          displayName: row.display_name,
          lastAuthMethod: row.last_auth_method,
        };
      }),
    );
  }

  findByEmail(email: string): Promise<UserByEmail | null> {
    return withDbInfra("user findByEmail failed", () => lookupUserByEmail(this.pool, email));
  }

  create(input: CreateUserInput): Promise<void> {
    return withDbInfra("user create failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        await client.query(
          `INSERT INTO users (id, owner_id, email, mfa_enrolled, last_auth_method, display_name)
           VALUES ($1, $1, $2, $3, $4, $5)`,
          [input.ownerId, input.email, input.mfaEnrolled, input.lastAuthMethod, input.displayName],
        );
        if (input.identity) {
          await client.query(
            `INSERT INTO user_identities (owner_id, issuer, sub)
             VALUES ($1, $2, $3)`,
            [input.ownerId, input.identity.issuer, input.identity.sub],
          );
        }
      }),
    );
  }

  updateAuthProfile(input: UpdateAuthProfileInput): Promise<void> {
    return withDbInfra("user updateAuthProfile failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        if (input.email !== undefined) {
          await client.query(
            `UPDATE users
             SET mfa_enrolled = $2,
                 last_auth_method = $3,
                 display_name = COALESCE($4, display_name),
                 email = $5
             WHERE id = $1`,
            [
              input.ownerId,
              input.mfaEnrolled,
              input.lastAuthMethod,
              input.displayName,
              input.email,
            ],
          );
        } else {
          await client.query(
            `UPDATE users
             SET mfa_enrolled = $2,
                 last_auth_method = $3,
                 display_name = COALESCE($4, display_name)
             WHERE id = $1`,
            [input.ownerId, input.mfaEnrolled, input.lastAuthMethod, input.displayName],
          );
        }
      }),
    );
  }

  linkIdentityAndUpdate(input: LinkIdentityAndUpdateInput): Promise<void> {
    return withDbInfra("user linkIdentityAndUpdate failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        await client.query(
          `INSERT INTO user_identities (owner_id, issuer, sub)
           VALUES ($1, $2, $3)`,
          [input.ownerId, input.issuer, input.sub],
        );
        await client.query(
          `UPDATE users
           SET mfa_enrolled = $2,
               last_auth_method = $3,
               display_name = COALESCE($4, display_name)
           WHERE id = $1`,
          [input.ownerId, input.mfaEnrolled, input.lastAuthMethod, input.displayName],
        );
      }),
    );
  }
}
