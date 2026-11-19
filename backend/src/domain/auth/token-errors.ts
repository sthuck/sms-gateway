/** Owner PAT protocol failures (not infrastructure). */
export type TokenErrorCode = "invalid_request" | "not_found" | "forbidden";

export class TokenError extends Error {
  readonly code: TokenErrorCode;
  readonly status: number;
  readonly retryable = false;

  constructor(code: TokenErrorCode, status: number, message: string) {
    super(message);
    this.name = "TokenError";
    this.code = code;
    this.status = status;
  }
}
