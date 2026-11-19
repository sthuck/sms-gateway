/** Owner personal access token (PAT) — read-only Bearer credential. */
export const OWNER_PAT_PREFIX = "smsg_pat_";

export const MAX_TOKEN_NAME_LEN = 120;

export type OwnerAccessToken = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/** Row returned by pre-owner SECURITY DEFINER lookup (includes hash). */
export type OwnerAccessTokenLookup = {
  id: string;
  ownerId: string;
  tokenHash: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export function isOwnerPatFormat(token: string): boolean {
  return token.startsWith(OWNER_PAT_PREFIX);
}

/**
 * Parse `smsg_pat_<uuid>_<secret>` into the token id.
 * Returns null when the shape is wrong (malformed → same 401 as unknown).
 */
export function parseOwnerPatTokenId(token: string): string | null {
  if (!isOwnerPatFormat(token)) return null;
  const rest = token.slice(OWNER_PAT_PREFIX.length);
  // UUID (with dashes) then `_` then base64url secret (may itself contain `_`).
  const sep = rest.indexOf("_");
  if (sep <= 0) return null;
  const id = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!secret) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

export function buildOwnerPatSecret(tokenId: string, secretPart: string): string {
  return `${OWNER_PAT_PREFIX}${tokenId}_${secretPart}`;
}
