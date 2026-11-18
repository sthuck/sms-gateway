import { CompactEncrypt, compactDecrypt } from "jose";
import { createSecretKey } from "node:crypto";

export type OAuthDanceState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
};

function secretKey(sessionSecret: string) {
  // Derive a 32-byte key from the configured secret.
  const buf = Buffer.from(sessionSecret, "utf8");
  if (buf.length >= 32) {
    return createSecretKey(buf.subarray(0, 32));
  }
  const padded = Buffer.alloc(32);
  buf.copy(padded);
  return createSecretKey(padded);
}

export async function sealOAuthState(
  payload: OAuthDanceState,
  sessionSecret: string,
): Promise<string> {
  const key = secretKey(sessionSecret);
  const encoder = new TextEncoder();
  return new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(key);
}

export async function openOAuthState(
  token: string,
  sessionSecret: string,
): Promise<OAuthDanceState> {
  const key = secretKey(sessionSecret);
  const { plaintext } = await compactDecrypt(token, key);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as OAuthDanceState;
  if (
    typeof parsed.state !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("Malformed OAuth state cookie");
  }
  if (parsed.exp * 1000 < Date.now()) {
    throw new Error("OAuth state cookie expired");
  }
  return parsed;
}
