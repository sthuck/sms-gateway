/**
 * Status-code parity matrix for pairing / device / queue failure modes.
 *
 * Documents the HTTP outcomes that must match main after the B2 hexagonal
 * move. Characterization coverage lives in device-auth.test.ts,
 * contract.test.ts, failure-modes.test.ts, and queue/*. This file is the
 * explicit matrix reviewers can diff against main behaviour.
 */
import { describe, expect, it } from "vitest";

type MatrixRow = {
  surface: string;
  condition: string;
  status: number;
  code: string;
  notes?: string;
};

const PAIRING_ISSUE: MatrixRow[] = [
  {
    surface: "POST /v1/pairing-codes",
    condition: "success",
    status: 201,
    code: "(body)",
  },
  {
    surface: "POST /v1/pairing-codes",
    condition: "unauthenticated",
    status: 401,
    code: "unauthorized",
  },
  {
    surface: "POST /v1/pairing-codes",
    condition: "CSRF reject",
    status: 403,
    code: "forbidden",
  },
  {
    surface: "POST /v1/pairing-codes",
    condition: "no DB / device config",
    status: 503,
    code: "service_unavailable",
  },
  {
    surface: "POST /v1/pairing-codes",
    condition: "DB insert failure",
    status: 500,
    code: "internal_error",
    notes: "InfrastructureError → retryable",
  },
];

const PAIR: MatrixRow[] = [
  { surface: "POST /v1/devices/pair", condition: "success", status: 201, code: "(body)" },
  {
    surface: "POST /v1/devices/pair",
    condition: "no DB / config",
    status: 503,
    code: "service_unavailable",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "IP / global rate limit",
    status: 429,
    code: "rate_limited",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "malformed body",
    status: 400,
    code: "invalid_request",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "bad SPKI",
    status: 400,
    code: "invalid_public_key",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "bad / expired / used / race code",
    status: 400,
    code: "invalid_pairing_code",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "content hash mismatch",
    status: 400,
    code: "content_hash_mismatch",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "clock skew",
    status: 401,
    code: "invalid_timestamp",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "bad signature",
    status: 401,
    code: "invalid_signature",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "replay",
    status: 401,
    code: "replay_detected",
  },
  {
    surface: "POST /v1/devices/pair",
    condition: "DB failure during burn/insert",
    status: 500,
    code: "internal_error",
    notes: "never invalid_pairing_code",
  },
];

const DEVICE_AUTH: MatrixRow[] = [
  {
    surface: "deviceAuthPreHandler",
    condition: "no pool/config/use-case",
    status: 503,
    code: "service_unavailable",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "missing/invalid headers",
    status: 400,
    code: "invalid_request",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "content hash mismatch",
    status: 400,
    code: "content_hash_mismatch",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "body > 1 MiB",
    status: 413,
    code: "payload_too_large",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "clock skew",
    status: 401,
    code: "invalid_timestamp",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "unknown device",
    status: 401,
    code: "device_unknown",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "bad signature",
    status: 401,
    code: "invalid_signature",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "revoked + rejectRevoked",
    status: 403,
    code: "device_revoked",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "replay",
    status: 401,
    code: "replay_detected",
  },
  {
    surface: "deviceAuthPreHandler",
    condition: "DB / replay infra failure",
    status: 500,
    code: "internal_error",
    notes: "never device_unknown (STH-46)",
  },
];

const DEVICE_ME_REVOKE: MatrixRow[] = [
  { surface: "GET /v1/devices/me", condition: "active device", status: 200, code: "(body)" },
  {
    surface: "GET /v1/devices/me",
    condition: "revoked device (valid sig)",
    status: 200,
    code: "(body+revoked_at)",
  },
  {
    surface: "GET /v1/devices/me",
    condition: "row missing after auth",
    status: 401,
    code: "device_unknown",
  },
  {
    surface: "POST /v1/devices/:id/revoke",
    condition: "success",
    status: 204,
    code: "(empty)",
  },
  {
    surface: "POST /v1/devices/:id/revoke",
    condition: "bad UUID",
    status: 400,
    code: "invalid_request",
  },
  {
    surface: "POST /v1/devices/:id/revoke",
    condition: "not visible / missing",
    status: 404,
    code: "not_found",
  },
];

const QUEUE: MatrixRow[] = [
  {
    surface: "publishInTx",
    condition: "commit",
    status: 0,
    code: "(job id)",
    notes: "job visible after commit",
  },
  {
    surface: "publishInTx",
    condition: "rollback",
    status: 0,
    code: "(no job)",
    notes: "job not visible",
  },
  {
    surface: "publishInTx / worker",
    condition: "pg-boss / DB failure",
    status: 0,
    code: "InfrastructureError",
    notes: "retry/DLQ unchanged",
  },
  {
    surface: "worker handler",
    condition: "repeated failure",
    status: 0,
    code: "(DLQ)",
    notes: "retry then dead-letter",
  },
];

describe("B2 behaviour parity matrix (pairing / device / queue)", () => {
  it("lists every pairing-issue outcome", () => {
    expect(PAIRING_ISSUE.length).toBeGreaterThanOrEqual(5);
    expect(PAIRING_ISSUE.every((r) => r.status >= 200)).toBe(true);
  });

  it("lists every pair outcome including infra → 500", () => {
    expect(PAIR.some((r) => r.code === "internal_error")).toBe(true);
    expect(PAIR.some((r) => r.code === "invalid_pairing_code")).toBe(true);
  });

  it("lists device-auth outcomes including infra → 500 not device_unknown", () => {
    const infra = DEVICE_AUTH.find((r) => r.condition.includes("infra"));
    expect(infra?.status).toBe(500);
    expect(infra?.code).toBe("internal_error");
  });

  it("lists me/revoke and queue retry/DLQ rows", () => {
    expect(DEVICE_ME_REVOKE.some((r) => r.status === 204)).toBe(true);
    expect(QUEUE.some((r) => r.notes?.includes("DLQ") || r.code === "(DLQ)")).toBe(true);
  });

  it("never maps infrastructure to auth/4xx codes in the matrix", () => {
    const all = [...PAIRING_ISSUE, ...PAIR, ...DEVICE_AUTH, ...DEVICE_ME_REVOKE];
    for (const row of all) {
      if (row.condition.toLowerCase().includes("db") || row.condition.includes("infra")) {
        expect([500, 503]).toContain(row.status);
        expect(["internal_error", "service_unavailable"]).toContain(row.code);
      }
    }
  });
});
