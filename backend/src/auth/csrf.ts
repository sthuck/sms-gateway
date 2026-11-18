import type { FastifyRequest } from "fastify";
import { sha256Hex } from "./crypto.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/**
 * CSRF defence for cookie-authenticated state-changing requests:
 * 1. SameSite=Lax session cookie (baseline).
 * 2. Double-submit: `sms_csrf` cookie must match `x-csrf-token` header
 *    (compared via hashes stored server-side on the session).
 * 3. Origin / Referer check when those headers are present.
 */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export function originAllowed(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (origin) {
    return allowedOrigins.includes(origin);
  }

  const referer = request.headers.referer;
  if (!referer) {
    // No Origin/Referer (e.g. same-site navigation tools); rely on double-submit.
    return true;
  }

  try {
    const refOrigin = new URL(referer).origin;
    return allowedOrigins.includes(refOrigin);
  } catch {
    return false;
  }
}

export function csrfTokensMatch(
  cookieToken: string | undefined,
  headerToken: string | undefined,
  sessionCsrfHash: string,
): boolean {
  if (!cookieToken || !headerToken) return false;
  if (cookieToken !== headerToken) return false;
  return sha256Hex(cookieToken) === sessionCsrfHash;
}

export function allowedOriginsFromConfig(opts: {
  publicBaseUrl: string | null;
  redirectUri: string;
}): string[] {
  const origins = new Set<string>();
  if (opts.publicBaseUrl) {
    origins.add(new URL(opts.publicBaseUrl).origin);
  }
  origins.add(new URL(opts.redirectUri).origin);
  return [...origins];
}
