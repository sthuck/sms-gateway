import type { Pool } from "pg";
import type { OwnerAccessTokenLookup } from "../../domain/auth/access-token.js";
import type { IdentityRecord, Session } from "../../domain/auth/types.js";

type IdentityRow = {
  identity_id: string;
  owner_id: string;
  email: string;
  mfa_enrolled: boolean;
  display_name: string | null;
};

type SessionRow = {
  session_row_id: string;
  owner_id: string;
  csrf_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
};

type EmailRow = {
  owner_id: string;
  email: string;
  mfa_enrolled: boolean;
};

/** SECURITY DEFINER: resolve (issuer, sub) without an owner GUC. */
export async function lookupUserIdentity(
  pool: Pool,
  issuer: string,
  sub: string,
): Promise<IdentityRecord | null> {
  const { rows } = await pool.query<IdentityRow>(`SELECT * FROM app.lookup_user_identity($1, $2)`, [
    issuer,
    sub,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    identityId: row.identity_id,
    ownerId: row.owner_id,
    email: row.email,
    mfaEnrolled: row.mfa_enrolled,
    displayName: row.display_name,
  };
}

/** SECURITY DEFINER: resolve session by hash without an owner GUC. */
export async function lookupSessionByHash(
  pool: Pool,
  sessionIdHash: string,
): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(`SELECT * FROM app.lookup_session($1)`, [
    sessionIdHash,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    sessionRowId: row.session_row_id,
    ownerId: row.owner_id,
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** SECURITY DEFINER: resolve user by email (auto-link path only). */
export async function lookupUserByEmail(
  pool: Pool,
  email: string,
): Promise<{ ownerId: string; email: string; mfaEnrolled: boolean } | null> {
  const { rows } = await pool.query<EmailRow>(`SELECT * FROM app.lookup_user_by_email($1)`, [
    email,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    email: row.email,
    mfaEnrolled: row.mfa_enrolled,
  };
}

type OwnerAccessTokenRow = {
  token_id: string;
  owner_id: string;
  token_hash: string;
  revoked_at: Date | null;
  last_used_at: Date | null;
};

/** SECURITY DEFINER: resolve owner PAT by id without an owner GUC (includes revoked). */
export async function lookupOwnerAccessTokenById(
  pool: Pool,
  tokenId: string,
): Promise<OwnerAccessTokenLookup | null> {
  const { rows } = await pool.query<OwnerAccessTokenRow>(
    `SELECT * FROM app.lookup_owner_access_token($1)`,
    [tokenId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.token_id,
    ownerId: row.owner_id,
    tokenHash: row.token_hash,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}
