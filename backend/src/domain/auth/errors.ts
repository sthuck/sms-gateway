export type AuthErrorCode =
  | "invalid_callback"
  | "mfa_required"
  | "unauthorized"
  | "user_not_found"
  | "auth_misconfigured"
  | "csrf_rejected";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryable: boolean;

  constructor(code: AuthErrorCode, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}
