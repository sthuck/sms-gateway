import { randomInt } from "node:crypto";
import { sha256HexUtf8 } from "./signing.js";

/**
 * Crockford Base32 alphabet (excludes I, L, O, U). 8 characters ≈ 40 bits
 * of entropy from a CSPRNG. Combined with per-IP rate limits and a global
 * invalid-attempt penalty (see docs/pairing.md), this is enough against
 * online guessing.
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_TTL_SECONDS = 5 * 60;

const PAIRING_PATTERN = /^[A-HJ-NP-TV-Za-hj-np-tv-z0-9]{4}-?[A-HJ-NP-TV-Za-hj-np-tv-z0-9]{4}$/;

/** Generate an 8-char Crockford code formatted as `XXXX-XXXX`. */
export function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Normalize for hashing / lookup: uppercase, strip hyphen.
 * Returns null if the string does not match the contract pattern.
 */
export function normalizePairingCode(raw: string): string | null {
  if (!PAIRING_PATTERN.test(raw)) return null;
  return raw.replace(/-/g, "").toUpperCase();
}

/** Hash only the normalized form; never store plaintext codes. */
export function hashPairingCode(normalized: string): string {
  return sha256HexUtf8(normalized);
}

export function formatPairingQrPayload(code: string, serverBaseUrl?: string | null): string {
  const params = new URLSearchParams();
  params.set("code", code);
  if (serverBaseUrl) {
    params.set("server", serverBaseUrl);
  }
  // URLSearchParams encodes; smsgw scheme uses standard query form.
  return `smsgw://pair?${params.toString()}`;
}
