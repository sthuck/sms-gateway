import type { Pool } from "pg";
import { REPLAY_TTL_SECONDS, sha256HexUtf8 } from "./signing.js";

export type ReplayKind = "nonce" | "signature";

/**
 * Postgres-backed replay cache shared across API instances.
 *
 * Keys: (identity, kind, sha256(value)) with TTL 360s per contract.
 * Identity is `device_id` or SHA-256 of the SPKI bytes (hex) at pairing.
 *
 * Justification: an in-memory Map would miss replays across replicas.
 * A short Postgres table with opportunistic TTL delete is enough for v1
 * (no Redis dependency). Stale rows are deleted on write and periodically
 * on read collisions.
 */
export async function isReplay(
  pool: Pool,
  identity: string,
  kind: ReplayKind,
  value: string,
): Promise<boolean> {
  const valueHash = sha256HexUtf8(value);
  await pool.query(`DELETE FROM app.device_replay_cache WHERE expires_at <= now()`);
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM app.device_replay_cache
       WHERE identity = $1 AND kind = $2 AND value_hash = $3 AND expires_at > now()
     ) AS exists`,
    [identity, kind, valueHash],
  );
  return Boolean(rows[0]?.exists);
}

export async function rememberReplay(
  pool: Pool,
  identity: string,
  kind: ReplayKind,
  value: string,
  ttlSeconds = REPLAY_TTL_SECONDS,
): Promise<void> {
  const valueHash = sha256HexUtf8(value);
  await pool.query(
    `INSERT INTO app.device_replay_cache (identity, kind, value_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (identity, kind, value_hash) DO UPDATE
       SET expires_at = EXCLUDED.expires_at`,
    [identity, kind, valueHash, ttlSeconds],
  );
}

export async function checkAndRememberReplay(
  pool: Pool,
  identity: string,
  nonce: string,
  signature: string,
): Promise<"ok" | "replay"> {
  if (await isReplay(pool, identity, "nonce", nonce)) return "replay";
  if (await isReplay(pool, identity, "signature", signature)) return "replay";
  await rememberReplay(pool, identity, "nonce", nonce);
  await rememberReplay(pool, identity, "signature", signature);
  return "ok";
}
