/**
 * Device / pairing credential and protocol failures (not infrastructure).
 * HTTP adapters map these to problem+json codes; never use for DB/network faults.
 */
export type DeviceErrorCode =
  | "invalid_request"
  | "content_hash_mismatch"
  | "payload_too_large"
  | "invalid_timestamp"
  | "device_unknown"
  | "invalid_signature"
  | "device_revoked"
  | "replay_detected"
  | "invalid_public_key"
  | "invalid_pairing_code"
  | "rate_limited"
  | "not_found"
  | "service_unavailable";

export class DeviceError extends Error {
  readonly code: DeviceErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly serverTime?: number | undefined;

  constructor(
    code: DeviceErrorCode,
    status: number,
    message: string,
    options?: { retryable?: boolean; serverTime?: number },
  ) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.status = status;
    this.retryable = options?.retryable ?? false;
    this.serverTime = options?.serverTime;
  }
}
