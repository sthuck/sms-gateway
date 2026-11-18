import type { Pool, PoolClient } from "pg";

export type DeviceAuthRow = {
  deviceId: string;
  ownerId: string;
  status: "active" | "revoked";
  publicKey: string;
  credentialRevokedAt: Date | null;
};

export type PairingCodeRow = {
  pairingCodeId: string;
  ownerId: string;
  expiresAt: Date;
};

export async function lookupDeviceForAuth(
  pool: Pool,
  deviceId: string,
): Promise<DeviceAuthRow | null> {
  const { rows } = await pool.query<{
    device_id: string;
    owner_id: string;
    status: "active" | "revoked";
    public_key: string;
    credential_revoked_at: Date | null;
  }>(`SELECT * FROM app.lookup_device_for_auth($1::uuid)`, [deviceId]);
  const row = rows[0];
  if (!row) return null;
  return {
    deviceId: row.device_id,
    ownerId: row.owner_id,
    status: row.status,
    publicKey: row.public_key,
    credentialRevokedAt: row.credential_revoked_at,
  };
}

export async function lookupPairingCode(
  pool: Pool,
  codeHash: string,
): Promise<PairingCodeRow | null> {
  const { rows } = await pool.query<{
    pairing_code_id: string;
    owner_id: string;
    expires_at: Date;
  }>(`SELECT * FROM app.lookup_pairing_code($1)`, [codeHash]);
  const row = rows[0];
  if (!row) return null;
  return {
    pairingCodeId: row.pairing_code_id,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
  };
}

/**
 * Atomically burn a pairing code under the owner's RLS context.
 * Returns true if this caller won the race.
 */
export async function burnPairingCode(client: PoolClient, pairingCodeId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE pairing_codes
     SET used_at = now()
     WHERE id = $1
       AND used_at IS NULL
       AND expires_at > now()`,
    [pairingCodeId],
  );
  return (rowCount ?? 0) === 1;
}
