export type ClaimMapping = {
  email: string;
  name: string;
};

export const DEFAULT_CLAIM_MAPPING: ClaimMapping = {
  email: "email",
  name: "name",
};

export type MappedClaims = {
  sub: string;
  email: string;
  name: string | null;
  amr: string[] | null;
  acr: string | null;
  raw: Record<string, unknown>;
};

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
  const amr = asStringArray(claims.amr);
  const acr = asString(claims.acr);

  return {
    sub,
    email,
    name,
    amr,
    acr,
    raw: claims,
  };
}
