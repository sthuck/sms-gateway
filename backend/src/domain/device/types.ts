/** Device credential row returned by SECURITY DEFINER lookup (pre-auth). */
export type DeviceAuthRecord = {
  deviceId: string;
  ownerId: string;
  status: "active" | "revoked";
  publicKey: string;
  credentialRevokedAt: Date | null;
};

export type PairingCodeRecord = {
  pairingCodeId: string;
  ownerId: string;
  expiresAt: Date;
};

export type PairedDevice = {
  deviceId: string;
  name: string;
  status: "active";
  pairedAt: string;
};

export type DeviceMe = {
  deviceId: string;
  name: string;
  status: "active" | "revoked";
  pairedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type DeviceInfo = {
  name?: string | undefined;
  platform: "android";
  manufacturer?: string | undefined;
  model?: string | undefined;
  os_version?: string | undefined;
  app_version: string;
  sdk_int?: number | undefined;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
  retryAfterSec: number;
};
