import { apiUrl, config } from "../config";
import { readCookie } from "./cookies";
import type { ProblemBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: ProblemBody | null;
  readonly retryable: boolean;

  constructor(status: number, message: string, problem: ProblemBody | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
    this.code = problem?.code;
    this.retryable = problem?.retryable ?? false;
  }
}

export type ApiClientOptions = {
  /** Called on 401 unauthorized (not mfa_required). Default: navigate to /login. */
  onUnauthorized?: () => void;
  getCsrfToken?: () => string | null;
  fetchImpl?: typeof fetch;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getCsrf = options.getCsrfToken ?? (() => readCookie(config.csrfCookieName));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (!SAFE_METHODS.has(method.toUpperCase())) {
      const csrf = getCsrf();
      if (csrf) {
        headers["X-CSRF-Token"] = csrf;
      }
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
    }

    const response = await fetchImpl(apiUrl(path), {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) {
      return undefined as T;
    }

    if (!response.ok) {
      const problem = await readProblem(response);
      const message = problem?.detail ?? problem?.title ?? `Request failed (${response.status})`;
      const error = new ApiError(response.status, message, problem);

      if (response.status === 401 && problem?.code !== "mfa_required") {
        options.onUnauthorized?.();
      }

      throw error;
    }

    if (response.status === 201 || response.headers.get("content-type")?.includes("json")) {
      return (await response.json()) as T;
    }

    return undefined as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    delete: <T>(path: string) => request<T>("DELETE", path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

async function readProblem(response: Response): Promise<ProblemBody | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return null;
  try {
    return (await response.json()) as ProblemBody;
  } catch {
    return null;
  }
}

/** Full-page navigation into the backend OIDC login (sets OAuth state cookie). */
export function startLoginRedirect(): void {
  window.location.assign(apiUrl("/v1/auth/login"));
}
