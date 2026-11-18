import type { Pool, PoolClient } from "pg";
import { REPLAY_TTL_SECONDS, sha256HexUtf8 } from "./signing.js";

export type ReplayKind = "nonce" | "signature";

/**
 * Postgres-backed replay cache shared across API instances.
 *
 * Keys: (identity, kind, sha256(value)) with TTL 360s per contract.
 * Identity is `device_id` or SHA-256 of the SPKI bytes (hex) at pairing.
 *
 * Claims are atomic insert-if-absent (`ON CONFLICT DO NOTHING RETURNING`)
 * so concurrent copies of the same signed request yield exactly one success.
 * Expired rows for the same key are removed inside the same transaction
 * before the insert so TTL reclaim does not race with live claims.
 */
export async function claimReplay(
  pool: Pool,
  identity: string,
  kind: ReplayKind,
  value: string,
  ttlSeconds = REPLAY_TTL_SECONDS,
): Promise<"ok" | "replay"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ok = await claimOnClient(client, identity, kind, value, ttlSeconds);
    if (!ok) {
      await client.query("ROLLBACK");
      return "replay";
    }
    await client.query("COMMIT");
    return "ok";
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically claim both nonce and signature after signature verification.
 * Uses a transaction so a lost race on either key rolls back both claims.
 */
export async function claimNonceAndSignature(
  pool: Pool,
  identity: string,
  nonce: string,
  signature: string,
  ttlSeconds = REPLAY_TTL_SECONDS,
): Promise<"ok" | "replay"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nonceOk = await claimOnClient(client, identity, "nonce", nonce, ttlSeconds);
    if (!nonceOk) {
      await client.query("ROLLBACK");
      return "replay";
    }
    const sigOk = await claimOnClient(client, identity, "signature", signature, ttlSeconds);
    if (!sigOk) {
      await client.query("ROLLBACK");
      return "replay";
    }
    await client.query("COMMIT");
    return "ok";
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function claimOnClient(
  client: PoolClient,
  identity: string,
  kind: ReplayKind,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  const valueHash = sha256HexUtf8(value);
  // Drop only an expired row for this exact key so a fresh claim can proceed.
  await client.query(
    `DELETE FROM app.device_replay_cache
     WHERE identity = $1 AND kind = $2 AND value_hash = $3 AND expires_at <= now()`,
    [identity, kind, valueHash],
  );
  const { rowCount } = await client.query(
    `INSERT INTO app.device_replay_cache (identity, kind, value_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (identity, kind, value_hash) DO NOTHING
     RETURNING 1`,
    [identity, kind, valueHash, ttlSeconds],
  );
  return (rowCount ?? 0) > 0;
}

/** Best-effort cleanup of expired rows (not on the hot path of every request). */
export async function purgeExpiredReplays(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM app.device_replay_cache WHERE expires_at <= now()`);
}
