import {
  createHash,
  createPublicKey,
  createPrivateKey,
  verify as cryptoVerify,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  buildCanonicalString,
  isTimestampInWindow,
  parseTimestampHeader,
  type CanonicalInputs,
} from "../../domain/device/canonical.js";

export { buildCanonicalString, isTimestampInWindow, parseTimestampHeader, type CanonicalInputs };

export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const CLOCK_SKEW_SECONDS = 300;
export const REPLAY_TTL_SECONDS = 360;
export const MAX_BODY_BYTES = 1_048_576;

export function sha256HexBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256HexUtf8(value: string): string {
  return sha256HexBytes(Buffer.from(value, "utf8"));
}

/** Unpadded base64url decode; returns null if the alphabet is invalid. */
export function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

export function encodeBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Import an unpadded base64url SPKI DER public key. Rejects non-P-256 keys.
 */
export function parsePublicKeySpkiB64url(b64url: string): KeyObject | null {
  const der = decodeBase64Url(b64url);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const jwk = key.export({ format: "jwk" });
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
    return key;
  } catch {
    return null;
  }
}

export function verifyEs256P1363(
  canonicalUtf8: string,
  signatureB64url: string,
  publicKey: KeyObject | string,
): boolean {
  const sig = decodeBase64Url(signatureB64url);
  if (!sig || sig.length !== 64) return false;
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(canonicalUtf8, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      sig,
    );
  } catch {
    return false;
  }
}

/** Test helper: sign a canonical string with a PKCS#8 PEM private key. */
export function signEs256P1363(canonicalUtf8: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign("sha256", Buffer.from(canonicalUtf8, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return encodeBase64Url(sig);
}

export function parseNonceHeader(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{22,86}$/.test(value)) return null;
  const bytes = decodeBase64Url(value);
  if (!bytes || bytes.length < 16 || bytes.length > 64) return null;
  return value;
}

export function parseSignatureHeader(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{86}$/.test(value)) return null;
  const bytes = decodeBase64Url(value);
  if (!bytes || bytes.length !== 64) return null;
  return value;
}

export function parseContentSha256Header(value: string | undefined): string | null {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  return value;
}
