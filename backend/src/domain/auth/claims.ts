import {
  DEFAULT_CLAIM_MAPPING,
  type ClaimMapping,
  type MappedClaims,
  type MfaClaimFields,
} from "./types.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > 0 ? items : null;
}

/**
 * Read amr/acr for MFA policy. Independent of email/name mapping so bearer
 * tokens without an email claim still get MFA enforcement (STH-36).
 */
export function extractMfaClaims(claims: Record<string, unknown>): MfaClaimFields {
  return {
    amr: asStringArray(claims.amr),
    acr: asString(claims.acr),
  };
}

/**
 * Map IdP token claims using configurable claim names.
 * Never keys identity on email alone — `sub` is required.
 */
export function mapClaims(
  claims: Record<string, unknown>,
  mapping: ClaimMapping = DEFAULT_CLAIM_MAPPING,
): MappedClaims {
  const sub = asString(claims.sub);
  if (!sub) {
    throw new Error("OIDC claims missing required sub");
  }

  const emailClaim = claims[mapping.email];
  const email = asString(emailClaim);
  if (!email) {
    throw new Error(`OIDC claims missing required email claim "${mapping.email}"`);
  }

  const name = asString(claims[mapping.name]);
  const { amr, acr } = extractMfaClaims(claims);

  return {
    sub,
    email,
    name,
    amr,
    acr,
    raw: claims,
  };
}
