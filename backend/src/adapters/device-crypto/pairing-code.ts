import { randomInt } from "node:crypto";
import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_TTL_SECONDS,
  formatPairingQrPayload,
  normalizePairingCode,
} from "../../domain/device/pairing.js";
import { sha256HexUtf8 } from "./signing.js";

export {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_TTL_SECONDS,
  formatPairingQrPayload,
  normalizePairingCode,
};

/** Generate an 8-char Crockford code formatted as `XXXX-XXXX`. */
export function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Hash only the normalized form; never store plaintext codes. */
export function hashPairingCode(normalized: string): string {
  return sha256HexUtf8(normalized);
}
