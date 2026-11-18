/**
 * Infrastructure failures (DB down, network to IdP/JWKS, timeouts).
 *
 * Ports MUST throw this (or let it propagate) for infra faults.
 * Ports MUST NOT return `null`/`undefined` to mean "error" — `null` means
 * domain absence only (not found / no row).
 *
 * HTTP adapters MUST map this to retryable 5xx (`internal_error` /
 * `service_unavailable`), never 401/403/404.
 */
export class InfrastructureError extends Error {
  readonly retryable = true;
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfrastructureError";
    this.cause = options?.cause;
  }

  static wrap(err: unknown, message: string): InfrastructureError {
    if (err instanceof InfrastructureError) return err;
    return new InfrastructureError(message, { cause: err });
  }
}

/** True when `err` is (or wraps) an infrastructure failure. */
export function isInfrastructureError(err: unknown): boolean {
  if (err instanceof InfrastructureError) return true;
  if (err && typeof err === "object" && "cause" in err) {
    return isInfrastructureError((err as { cause?: unknown }).cause);
  }
  return false;
}
