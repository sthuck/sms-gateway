import type { FastifyReply } from "fastify";

export type ProblemCode =
  | "invalid_request"
  | "unauthorized"
  | "mfa_required"
  | "csrf_rejected"
  | "auth_misconfigured"
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
};

const TITLES: Record<ProblemCode, string> = {
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  mfa_required: "Multi-factor authentication required",
  csrf_rejected: "CSRF validation failed",
  auth_misconfigured: "Authentication is not configured",
  internal_error: "Internal error",
  service_unavailable: "Service unavailable",
};

export function problemType(code: ProblemCode): string {
  return `https://sms-gateway.example/problems/${code}`;
}

export function buildProblem(
  code: ProblemCode,
  status: number,
  detail?: string,
  options?: { retryable?: boolean; instance?: string },
): ProblemBody {
  return {
    type: problemType(code),
    title: TITLES[code],
    status,
    detail,
    instance: options?.instance,
    code,
    retryable: options?.retryable ?? false,
  };
}

export function sendProblem(
  reply: FastifyReply,
  code: ProblemCode,
  status: number,
  detail?: string,
  options?: { retryable?: boolean; instance?: string },
): FastifyReply {
  const body = buildProblem(code, status, detail, options);
  return reply
    .status(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send(body);
}
