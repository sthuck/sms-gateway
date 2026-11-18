/**
 * Negative-proof fixture: STH-46 root cause — helper maps unknown errors to 401.
 */
export function mapAuthError(
  sendProblem: (code: string, status: number, detail: string) => void,
  err: unknown,
  fallbackDetail: string,
): void {
  class AuthError extends Error {
    code = "unauthorized";
  }
  if (err instanceof AuthError) {
    sendProblem("unauthorized", 401, err.message);
    return;
  }
  sendProblem("unauthorized", 401, fallbackDetail);
}
