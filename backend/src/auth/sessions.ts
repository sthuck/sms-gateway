import type { Pool, PoolClient } from "pg";
import { randomToken, sha256Hex } from "./crypto.js";
import { withOwner } from "../db/with-owner.js";

export type SessionRecord = {
  sessionRowId: string;
  ownerId: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type CreatedSession = {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  ownerId: string;
};

export async function createSession(
  pool: Pool,
  ownerId: string,
  ttlSeconds: number,
): Promise<CreatedSession> {
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await withOwner(pool, ownerId, async (client) => {
    await client.query(
      `INSERT INTO sessions (owner_id, session_id_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [ownerId, sha256Hex(sessionId), sha256Hex(csrfToken), expiresAt.toISOString()],
    );
  });

  return { sessionId, csrfToken, expiresAt, ownerId };
}

export async function lookupSession(pool: Pool, sessionId: string): Promise<SessionRecord | null> {
  const { rows } = await pool.query<{
    session_row_id: string;
    owner_id: string;
    csrf_token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(`SELECT * FROM app.lookup_session($1)`, [sha256Hex(sessionId)]);

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

export function isSessionActive(session: SessionRecord, now = new Date()): boolean {
  if (session.revokedAt) return false;
  return session.expiresAt.getTime() > now.getTime();
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<boolean> {
  const existing = await lookupSession(pool, sessionId);
  if (!existing || !isSessionActive(existing)) {
    return false;
  }

  await withOwner(pool, existing.ownerId, async (client) => {
    await client.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE session_id_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(sessionId)],
    );
  });
  return true;
}

export async function touchSession(client: PoolClient, sessionRowId: string): Promise<void> {
  await client.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionRowId]);
}
