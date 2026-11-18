import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withOwner } from "../db/with-owner.js";
import type { MappedClaims } from "./claims.js";

export type ResolvedUser = {
  ownerId: string;
  email: string;
  mfaEnrolled: boolean;
  displayName: string | null;
  created: boolean;
};

type IdentityRow = {
  identity_id: string;
  owner_id: string;
  email: string;
  mfa_enrolled: boolean;
  display_name: string | null;
};

/**
 * Resolve (issuer, sub) → users.id. First login provisions user + identity
 * in one transaction. Never keys users on email alone; auto-link by email
 * is opt-in and off by default (account-takeover risk if an IdP email is
 * not verified).
 */
export async function findOrProvisionUser(
  pool: Pool,
  issuer: string,
  claims: MappedClaims,
  options: {
    mfaEnrolled: boolean;
    lastAuthMethod: string | null;
    autoLinkByEmail: boolean;
  },
): Promise<ResolvedUser> {
  const existing = await lookupIdentity(pool, issuer, claims.sub);
  if (existing) {
    await withOwner(pool, existing.owner_id, async (client) => {
      await client.query(
        `UPDATE users
         SET mfa_enrolled = $2,
             last_auth_method = $3,
             display_name = COALESCE($4, display_name),
             email = $5
         WHERE id = $1`,
        [existing.owner_id, options.mfaEnrolled, options.lastAuthMethod, claims.name, claims.email],
      );
    });
    return {
      ownerId: existing.owner_id,
      email: claims.email,
      mfaEnrolled: options.mfaEnrolled,
      displayName: claims.name ?? existing.display_name,
      created: false,
    };
  }

  if (options.autoLinkByEmail) {
    const byEmail = await lookupByEmail(pool, claims.email);
    if (byEmail) {
      await withOwner(pool, byEmail.owner_id, async (client) => {
        await client.query(
          `INSERT INTO user_identities (owner_id, issuer, sub)
           VALUES ($1, $2, $3)`,
          [byEmail.owner_id, issuer, claims.sub],
        );
        await client.query(
          `UPDATE users
           SET mfa_enrolled = $2,
               last_auth_method = $3,
               display_name = COALESCE($4, display_name)
           WHERE id = $1`,
          [byEmail.owner_id, options.mfaEnrolled, options.lastAuthMethod, claims.name],
        );
      });
      return {
        ownerId: byEmail.owner_id,
        email: byEmail.email,
        mfaEnrolled: options.mfaEnrolled,
        displayName: claims.name,
        created: false,
      };
    }
  }

  const ownerId = randomUUID();
  await withOwner(pool, ownerId, async (client) => {
    await client.query(
      `INSERT INTO users (id, owner_id, email, mfa_enrolled, last_auth_method, display_name)
       VALUES ($1, $1, $2, $3, $4, $5)`,
      [ownerId, claims.email, options.mfaEnrolled, options.lastAuthMethod, claims.name],
    );
    await client.query(
      `INSERT INTO user_identities (owner_id, issuer, sub)
       VALUES ($1, $2, $3)`,
      [ownerId, issuer, claims.sub],
    );
  });

  return {
    ownerId,
    email: claims.email,
    mfaEnrolled: options.mfaEnrolled,
    displayName: claims.name,
    created: true,
  };
}

async function lookupIdentity(
  pool: Pool,
  issuer: string,
  sub: string,
): Promise<IdentityRow | null> {
  const { rows } = await pool.query<IdentityRow>(`SELECT * FROM app.lookup_user_identity($1, $2)`, [
    issuer,
    sub,
  ]);
  return rows[0] ?? null;
}

async function lookupByEmail(
  pool: Pool,
  email: string,
): Promise<{ owner_id: string; email: string; mfa_enrolled: boolean } | null> {
  const { rows } = await pool.query<{
    owner_id: string;
    email: string;
    mfa_enrolled: boolean;
  }>(`SELECT * FROM app.lookup_user_by_email($1)`, [email]);
  return rows[0] ?? null;
}

/** Resolve owner from a verified bearer JWT (issuer, sub). */
export async function resolveOwnerFromIdentity(
  pool: Pool,
  issuer: string,
  sub: string,
): Promise<ResolvedUser | null> {
  const row = await lookupIdentity(pool, issuer, sub);
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    email: row.email,
    mfaEnrolled: row.mfa_enrolled,
    displayName: row.display_name,
    created: false,
  };
}
