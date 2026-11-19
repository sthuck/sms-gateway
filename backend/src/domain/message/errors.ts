/**
 * Owner inbox / message protocol failures (not infrastructure).
 * HTTP adapters map these to problem+json; never use for DB/network faults.
 */
export type MessageErrorCode = "invalid_request" | "not_found";

export type MessageFieldError = {
  path: string;
  message: string;
};

export class MessageError extends Error {
  readonly code: MessageErrorCode;
  readonly status: number;
  readonly retryable = false;
  readonly errors?: MessageFieldError[] | undefined;

  constructor(
    code: MessageErrorCode,
    status: number,
    message: string,
    options?: { errors?: MessageFieldError[] },
  ) {
    super(message);
    this.name = "MessageError";
    this.code = code;
    this.status = status;
    this.errors = options?.errors;
  }
}
