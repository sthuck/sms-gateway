/**
 * Owner stream protocol / validation failures (not infrastructure).
 * HTTP adapters map these to problem+json; never use for DB/network faults.
 */
export type StreamErrorCode = "invalid_request" | "not_found";

export type StreamFieldError = {
  path: string;
  message: string;
};

export class StreamError extends Error {
  readonly code: StreamErrorCode;
  readonly status: number;
  readonly retryable = false;
  readonly errors?: StreamFieldError[] | undefined;

  constructor(
    code: StreamErrorCode,
    status: number,
    message: string,
    options?: { errors?: StreamFieldError[] },
  ) {
    super(message);
    this.name = "StreamError";
    this.code = code;
    this.status = status;
    this.errors = options?.errors;
  }
}
