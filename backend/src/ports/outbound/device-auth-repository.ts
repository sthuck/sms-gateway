import type {
  DeviceAuthRecord,
  DeviceMe,
  DeviceInfo,
  PairedDevice,
} from "../../domain/device/types.js";

/**
 * Device persistence for auth and management.
 *
 * - `null` from lookup = not found (domain absence).
 * - Infra failures (DB down, query error) MUST throw `InfrastructureError`
 *   (never return null for errors).
 */
export type DeviceAuthRepository = {
  lookupForAuth(deviceId: string): Promise<DeviceAuthRecord | null>;

  /**
   * Atomically burn the pairing code and insert device + credential + audit
   * under the owner's RLS context. Returns `null` when the burn lost the race
   * (domain outcome — code already used / expired).
   */
  pairWithBurnedCode(input: {
    ownerId: string;
    pairingCodeId: string;
    displayName: string;
    publicKey: string;
    deviceInfo: DeviceInfo;
    clientIp: string;
  }): Promise<PairedDevice | null>;

  findMe(ownerId: string, deviceId: string): Promise<DeviceMe | null>;

  revoke(ownerId: string, deviceId: string, clientIp: string): Promise<"ok" | "missing">;
};
