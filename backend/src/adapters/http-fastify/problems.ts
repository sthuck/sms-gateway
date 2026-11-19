import type { FastifyReply } from "fastify";

/** User-auth and device-auth problem codes (RFC 9457 + contract `code`). */
export type ProblemCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "mfa_required"
  | "csrf_rejected"
  | "auth_misconfigured"
  | "not_found"
  | "content_hash_mismatch"
  | "invalid_pairing_code"
  | "invalid_public_key"
  | "invalid_signature"
  | "invalid_timestamp"
  | "replay_detected"
  | "device_unknown"
  | "device_revoked"
  | "payload_too_large"
  | "batch_too_large"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable";

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string | undefined;
  instance?: string | undefined;
  code: ProblemCode;
  retryable: boolean;
  server_time?: number | undefined;
};

const TITLES: Record<ProblemCode, string> = {
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  mfa_required: "Multi-factor authentication required",
  csrf_rejected: "CSRF validation failed",
  auth_misconfigured: "Authentication is not configured",
  not_found: "Not found",
  content_hash_mismatch: "Content hash mismatch",
  invalid_pairing_code: "Invalid pairing code",
  invalid_public_key: "Invalid public key",
  invalid_signature: "Invalid signature",
  invalid_timestamp: "Invalid timestamp",
  replay_detected: "Replay detected",
  device_unknown: "Unknown device",
  device_revoked: "Device revoked",
  payload_too_large: "Payload too large",
  batch_too_large: "Batch too large",
  rate_limited: "Rate limited",
  internal_error: "Internal error",
  service_unavailable: "Service unavailable",
};

const DEFAULT_RETRYABLE: Partial<Record<ProblemCode, boolean>> = {
  invalid_timestamp: true,
  replay_detected: true,
  rate_limited: true,
  internal_error: true,
  service_unavailable: true,
};

export type SendProblemOptions = {
  retryable?: boolean;
  instance?: string;
  server_time?: number;
  headers?: Record<string, string | number>;
};

export function problemType(code: ProblemCode): string {
  return `https://sms-gateway.example/problems/${code}`;
}

export function buildProblem(
  code: ProblemCode,
  status: number,
  detail?: string,
  options?: SendProblemOptions,
): ProblemBody {
  const body: ProblemBody = {
    type: problemType(code),
    title: TITLES[code],
    status,
    detail,
    instance: options?.instance,
    code,
    retryable: options?.retryable ?? DEFAULT_RETRYABLE[code] ?? false,
  };
  if (options?.server_time !== undefined) {
    body.server_time = options.server_time;
  }
  return body;
}

export function sendProblem(
  reply: FastifyReply,
  code: ProblemCode,
  status: number,
  detail?: string,
  options?: SendProblemOptions,
): FastifyReply {
  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      void reply.header(key, value);
    }
  }
  if (code === "invalid_timestamp") {
    const serverTime = options?.server_time ?? Math.floor(Date.now() / 1000);
    void reply.header("Date", new Date(serverTime * 1000).toUTCString());
    options = { ...options, server_time: serverTime };
  }
  const body = buildProblem(code, status, detail, options);
  return reply
    .status(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send(body);
}
