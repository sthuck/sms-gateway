import type { Pool } from "pg";
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
