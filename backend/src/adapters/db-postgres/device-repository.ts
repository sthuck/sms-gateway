import type { Pool } from "pg";
import type {
  DeviceAuthRecord,
  DeviceInfo,
  DeviceListItem,
  DeviceMe,
  PairedDevice,
} from "../../domain/device/types.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";
import { burnPairingCode, lookupDeviceForAuth } from "./device-lookups.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

type DeviceListRow = {
  id: string;
  name: string;
  status: "active" | "revoked";
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
};

function mapDeviceListRow(row: DeviceListRow): DeviceListItem {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export class PgDeviceAuthRepository implements DeviceAuthRepository {
  constructor(private readonly pool: Pool) {}

  lookupForAuth(deviceId: string): Promise<DeviceAuthRecord | null> {
    return lookupDeviceForAuth(this.pool, deviceId);
  }

  pairWithBurnedCode(input: {
    ownerId: string;
    pairingCodeId: string;
    displayName: string;
    publicKey: string;
    deviceInfo: DeviceInfo;
    clientIp: string;
  }): Promise<PairedDevice | null> {
    return withDbInfra("device pair insert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const burned = await burnPairingCode(client, input.pairingCodeId);
        if (!burned) return null;

        const device = await client.query<{
          id: string;
          name: string;
          status: string;
          created_at: Date;
        }>(
          `INSERT INTO devices (owner_id, name, platform_info, status, last_seen_at)
           VALUES (
             app.current_owner_id(),
             $1,
             $2::jsonb,
             'active',
             now()
           )
           RETURNING id, name, status, created_at`,
          [input.displayName, JSON.stringify(input.deviceInfo)],
        );
        const deviceRow = device.rows[0]!;

        await client.query(
          `INSERT INTO device_credentials (owner_id, device_id, public_key)
           VALUES (app.current_owner_id(), $1, $2)`,
          [deviceRow.id, input.publicKey],
        );

        await client.query(
          `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, ip)
           VALUES (app.current_owner_id(), 'device', $1, 'device.pair', $2::inet)`,
          [deviceRow.id, input.clientIp],
        );

        return {
          deviceId: deviceRow.id,
          name: deviceRow.name,
          status: "active" as const,
          pairedAt: deviceRow.created_at.toISOString(),
        };
      }),
    );
  }

  findMe(ownerId: string, deviceId: string): Promise<DeviceMe | null> {
    return withDbInfra("device me lookup failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [deviceId]);
        const { rows } = await client.query<{
          id: string;
          name: string;
          status: "active" | "revoked";
          created_at: Date;
          last_seen_at: Date | null;
          revoked_at: Date | null;
        }>(
          `SELECT d.id, d.name, d.status, d.created_at, d.last_seen_at, dc.revoked_at
           FROM devices d
           JOIN device_credentials dc ON dc.device_id = d.id
           WHERE d.id = $1`,
          [deviceId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          deviceId: row.id,
          name: row.name,
          status: row.status,
          pairedAt: row.created_at.toISOString(),
          lastSeenAt: (row.last_seen_at ?? new Date()).toISOString(),
          revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        };
      }),
    );
  }

  list(ownerId: string, limit: number): Promise<DeviceListItem[]> {
    return withDbInfra("device list failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<DeviceListRow>(
          `SELECT d.id, d.name, d.status, d.created_at, d.last_seen_at, dc.revoked_at
           FROM devices d
           LEFT JOIN device_credentials dc ON dc.device_id = d.id
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT $1`,
          [limit],
        );
        return rows.map(mapDeviceListRow);
      }),
    );
  }

  rename(ownerId: string, deviceId: string, name: string): Promise<DeviceListItem | null> {
    return withDbInfra("device rename failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const updated = await client.query<{ id: string }>(
          `UPDATE devices SET name = $1 WHERE id = $2 RETURNING id`,
          [name, deviceId],
        );
        if (!updated.rows[0]) return null;

        const { rows } = await client.query<DeviceListRow>(
          `SELECT d.id, d.name, d.status, d.created_at, d.last_seen_at, dc.revoked_at
           FROM devices d
           LEFT JOIN device_credentials dc ON dc.device_id = d.id
           WHERE d.id = $1`,
          [deviceId],
        );
        const row = rows[0];
        return row ? mapDeviceListRow(row) : null;
      }),
    );
  }

  revoke(ownerId: string, deviceId: string, clientIp: string): Promise<"ok" | "missing"> {
    return withDbInfra("device revoke failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const exists = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM devices WHERE id = $1`,
          [deviceId],
        );
        if (!exists.rows[0]) return "missing" as const;

        await client.query(`UPDATE devices SET status = 'revoked' WHERE id = $1`, [deviceId]);
        await client.query(
          `UPDATE device_credentials
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE device_id = $1`,
          [deviceId],
        );
        await client.query(
          `INSERT INTO audit_log (owner_id, actor_type, actor_id, action, ip)
           VALUES (app.current_owner_id(), 'user', app.current_owner_id(), 'device.revoke', $1::inet)`,
          [clientIp],
        );
        return "ok" as const;
      }),
    );
  }
}
