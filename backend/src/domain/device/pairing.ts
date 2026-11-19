import { encodeAccessHeadersParam, type AccessHeadersMap } from "../access-headers.js";

/**
 * Crockford Base32 alphabet (excludes I, L, O, U). Pure string helpers only —
 * CSPRNG generation and hashing live in adapters (node:crypto).
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_TTL_SECONDS = 5 * 60;

const PAIRING_PATTERN = /^[A-HJ-NP-TV-Za-hj-np-tv-z0-9]{4}-?[A-HJ-NP-TV-Za-hj-np-tv-z0-9]{4}$/;

/**
 * Normalize for hashing / lookup: uppercase, strip hyphen.
 * Returns null if the string does not match the contract pattern.
 */
export function normalizePairingCode(raw: string): string | null {
  if (!PAIRING_PATTERN.test(raw)) return null;
  return raw.replace(/-/g, "").toUpperCase();
}

export function formatPairingQrPayload(
  code: string,
  serverBaseUrl?: string | null,
  accessHeaders?: AccessHeadersMap | null,
): string {
  const params = new URLSearchParams();
  params.set("code", code);
  if (serverBaseUrl) {
    params.set("server", serverBaseUrl);
  }
  if (accessHeaders && Object.keys(accessHeaders).length > 0) {
    params.set("headers", encodeAccessHeadersParam(accessHeaders));
  }
  return `smsgw://pair?${params.toString()}`;
}

export function displayNameFromDeviceInfo(info: {
  name?: string | undefined;
  manufacturer?: string | undefined;
  model?: string | undefined;
}): string {
  if (info.name) return info.name;
  const fromParts = [info.manufacturer, info.model].filter(Boolean).join(" ");
  return fromParts || "Android device";
}
