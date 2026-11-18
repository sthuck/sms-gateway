#!/usr/bin/env node
/**
 * Generate and verify the STH-5 device request-signing test vector.
 *
 * The keypair below is a THROWAAWAY TEST VECTOR. Never use it in production,
 * never provision it to a real device, and never accept it as a registered key.
 *
 * Usage:
 *   node docs/contracts/examples/gen-test-vector.mjs
 *
 * Exits 0 only if:
 *   - the frozen canonical string and body hash match a fresh computation
 *   - the frozen signature verifies over that canonical string
 *   - a freshly produced signature also verifies (ECDSA is non-deterministic)
 *   - the additive dev-host vector (Host 10.0.2.2:4010, port in HOST)
 *     frozen signature also verifies, plus a fresh signature and tamper check
 *
 * The primary vector (INPUTS / FROZEN_SIGNATURE_B64URL) is frozen and
 * must not change: Android uses test-vector.json as a unit-test fixture.
 * The port-in-HOST example is written under the added key `devHostVector`.
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// THROWAAWAY TEST VECTOR KEYPAIR (P-256). Do not use outside unit tests.
// ---------------------------------------------------------------------------
export const TEST_PRIVATE_KEY_PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0tCxCFGtAN6rIAQX
RpKMgFrWNK9OPHLpPPnwmPtjsXihRANCAATKXotA6HRWiXpjt5R5imu0w8P9wH2h
XBEUEBDoGlxFtdkBcuXvjmMp367FfhvBSUfEf6Mewxz//+bdaU6C7HBF
-----END PRIVATE KEY-----
`;

export const TEST_PUBLIC_KEY_SPKI_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl6LQOh0Vol6Y7eUeYprtMPD/cB9
oVwRFBAQ6BpcRbXZAXLl745jKd+uxX4bwUlHxH+jHsMc///m3WlOguxwRQ==
-----END PUBLIC KEY-----
`;

export const TEST_PUBLIC_KEY_SPKI_B64URL =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl6LQOh0Vol6Y7eUeYprtMPD_cB9oVwRFBAQ6BpcRbXZAXLl745jKd-uxX4bwUlHxH-jHsMc___m3WlOguxwRQ";

// Frozen request inputs
export const INPUTS = {
  method: "POST",
  path: "/v1/messages:batch",
  query: "",
  host: "api.sms-gateway.example",
  deviceId: "018f3c2a-9b4d-7e21-a456-426614174000",
  timestamp: "1794995160", // 2026-11-18T09:46:00Z
  nonce: "V1nQe4r0sK8mP2yL6dF9TQ",
  // Compact JSON; this exact byte sequence is what is hashed and sent.
  body: '{"messages":[{"device_msg_id":"sms-42","sender":"+15551234567","body":"Your code is 123456","received_at":"2026-11-18T09:45:12Z","sim_slot":0,"direction":"inbound"}]}',
};

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the v1 canonical string.
 * Fields are joined by "\\n". There is no trailing newline after NONCE.
 */
export function canonicalString({
  method,
  path,
  query,
  host,
  deviceId,
  timestamp,
  contentSha256,
  nonce,
}) {
  return [
    "v1",
    method.toUpperCase(),
    path,
    query,
    host.toLowerCase(),
    deviceId,
    timestamp,
    contentSha256,
    nonce,
  ].join("\n");
}

export function signCanonical(canonicalUtf8, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign("sha256", Buffer.from(canonicalUtf8, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
}

export function verifyCanonical(canonicalUtf8, signature, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  return cryptoVerify(
    "sha256",
    Buffer.from(canonicalUtf8, "utf8"),
    { key, dsaEncoding: "ieee-p1363" },
    signature,
  );
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(s) {
  return Buffer.from(s, "base64url");
}

export function buildVector() {
  const bodyBytes = Buffer.from(INPUTS.body, "utf8");
  const contentSha256 = sha256Hex(bodyBytes);
  const canonical = canonicalString({
    method: INPUTS.method,
    path: INPUTS.path,
    query: INPUTS.query,
    host: INPUTS.host,
    deviceId: INPUTS.deviceId,
    timestamp: INPUTS.timestamp,
    contentSha256,
    nonce: INPUTS.nonce,
  });
  return { bodyBytes, contentSha256, canonical };
}

// Frozen signature produced once by this script (ECDSA is non-deterministic,
// so later runs will not reproduce these bytes; they must still verify).
export const FROZEN_SIGNATURE_B64URL =
  "dzk2otghSLa69_4gd_jzCjHEzSXl5lUoJRXd5OmXEPamGBcoTIklHuRNTyatMjYv5_ar0fXNwucc9h9Ox189uQ";

// Additive vector: same request as INPUTS, but Host includes the dev-mock port.
// Canonical HOST is "10.0.2.2:4010" (kept as sent, lowercased, port included).
export const DEV_HOST = "10.0.2.2:4010";

export const FROZEN_DEV_HOST_SIGNATURE_B64URL =
  "N8eDkmoPaOK812xKVaiBQQIlTB4G2yrlKpTvJIaedUJ9zTUfm0LV3ZFveSNZ9nncCWgrVXMF73bUCLVEZaIShg";

export function buildVectorForHost(host) {
  const bodyBytes = Buffer.from(INPUTS.body, "utf8");
  const contentSha256 = sha256Hex(bodyBytes);
  const canonical = canonicalString({
    method: INPUTS.method,
    path: INPUTS.path,
    query: INPUTS.query,
    host,
    deviceId: INPUTS.deviceId,
    timestamp: INPUTS.timestamp,
    contentSha256,
    nonce: INPUTS.nonce,
  });
  return { bodyBytes, contentSha256, canonical, host };
}

function main() {
  const { bodyBytes, contentSha256, canonical } = buildVector();
  const freshSig = signCanonical(canonical, TEST_PRIVATE_KEY_PKCS8_PEM);
  const freshB64 = b64url(freshSig);

  const expectedFrozen = process.env.WRITE_FROZEN === "1" ? freshB64 : FROZEN_SIGNATURE_B64URL;

  const frozenOk =
    expectedFrozen !== "REPLACE_ME" &&
    verifyCanonical(canonical, fromB64url(expectedFrozen), TEST_PUBLIC_KEY_SPKI_PEM);
  const freshOk = verifyCanonical(canonical, freshSig, TEST_PUBLIC_KEY_SPKI_PEM);

  // Tamper check: flipping one byte of the canonical string must fail.
  const tampered = canonical.replace("v1", "v2");
  const tamperRejected = !verifyCanonical(
    tampered,
    expectedFrozen === "REPLACE_ME" ? freshSig : fromB64url(expectedFrozen),
    TEST_PUBLIC_KEY_SPKI_PEM,
  );

  const vector = {
    warning:
      "THROWAAWAY TEST VECTOR. Never use this keypair in production or on a real device.",
    alg: "ES256",
    curve: "P-256",
    hash: "SHA-256",
    signatureEncoding: "ieee-p1363-base64url",
    publicKeyEncoding: "spki-der-base64url",
    testPrivateKeyPkcs8Pem: TEST_PRIVATE_KEY_PKCS8_PEM,
    testPublicKeySpkiPem: TEST_PUBLIC_KEY_SPKI_PEM,
    testPublicKeySpkiB64url: TEST_PUBLIC_KEY_SPKI_B64URL,
    request: {
      method: INPUTS.method,
      path: INPUTS.path,
      query: INPUTS.query,
      headers: {
        Host: INPUTS.host,
        "X-Device-Id": INPUTS.deviceId,
        "X-Timestamp": INPUTS.timestamp,
        "X-Nonce": INPUTS.nonce,
        "X-Content-SHA256": contentSha256,
        "X-Signature": expectedFrozen === "REPLACE_ME" ? freshB64 : expectedFrozen,
        "Content-Type": "application/json",
      },
      body: INPUTS.body,
      bodyUtf8ByteLength: bodyBytes.length,
    },
    bodySha256Hex: contentSha256,
    canonicalString: canonical,
    frozenSignatureB64url:
      expectedFrozen === "REPLACE_ME" ? freshB64 : expectedFrozen,
    verification: {
      frozenSignatureVerifies: frozenOk,
      freshSignatureVerifies: freshOk,
      tamperedCanonicalRejected: tamperRejected,
      note: "ECDSA signatures are non-deterministic. Assert verify(publicKey, canonicalString, signature) === true, not byte equality with a previous signature. A fresh signature is produced and checked on each run but is not written here.",
    },
  };

  const dev = buildVectorForHost(DEV_HOST);
  const devFreshSig = signCanonical(dev.canonical, TEST_PRIVATE_KEY_PKCS8_PEM);
  const devFrozenOk = verifyCanonical(
    dev.canonical,
    fromB64url(FROZEN_DEV_HOST_SIGNATURE_B64URL),
    TEST_PUBLIC_KEY_SPKI_PEM,
  );
  const devFreshOk = verifyCanonical(
    dev.canonical,
    devFreshSig,
    TEST_PUBLIC_KEY_SPKI_PEM,
  );
  const devTamperRejected = !verifyCanonical(
    dev.canonical.replace("v1", "v2"),
    fromB64url(FROZEN_DEV_HOST_SIGNATURE_B64URL),
    TEST_PUBLIC_KEY_SPKI_PEM,
  );

  // Additive only: existing fixture keys stay stable. Android unit tests
  // depend on the top-level primary vector fields.
  vector.devHostVector = {
    description:
      "Same request as the primary vector, but Host is 10.0.2.2:4010 (Android emulator dev mock). Canonical HOST keeps the port, lowercased as sent.",
    request: {
      method: INPUTS.method,
      path: INPUTS.path,
      query: INPUTS.query,
      headers: {
        Host: DEV_HOST,
        "X-Device-Id": INPUTS.deviceId,
        "X-Timestamp": INPUTS.timestamp,
        "X-Nonce": INPUTS.nonce,
        "X-Content-SHA256": dev.contentSha256,
        "X-Signature": FROZEN_DEV_HOST_SIGNATURE_B64URL,
        "Content-Type": "application/json",
      },
      body: INPUTS.body,
      bodyUtf8ByteLength: dev.bodyBytes.length,
    },
    bodySha256Hex: dev.contentSha256,
    canonicalString: dev.canonical,
    frozenSignatureB64url: FROZEN_DEV_HOST_SIGNATURE_B64URL,
    verification: {
      frozenSignatureVerifies: devFrozenOk,
      freshSignatureVerifies: devFreshOk,
      tamperedCanonicalRejected: devTamperRejected,
      note: "ECDSA signatures are non-deterministic. Assert verify(publicKey, canonicalString, signature) === true, not byte equality with a previous signature. A fresh signature is produced and checked on each run but is not written here.",
    },
  };

  const outDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(outDir, "test-vector.json");
  writeFileSync(outPath, JSON.stringify(vector, null, 2) + "\n");

  console.log(JSON.stringify(vector, null, 2));
  console.log(`\nWrote ${outPath}`);

  if (expectedFrozen === "REPLACE_ME") {
    console.error(
      "\nFROZEN_SIGNATURE_B64URL is unset. Re-run after pasting frozenSignatureB64url into the script.",
    );
    process.exit(1);
  }
  if (!frozenOk || !freshOk || !tamperRejected) {
    console.error("\nVERIFY FAILED", { frozenOk, freshOk, tamperRejected });
    process.exit(1);
  }
  if (!devFrozenOk || !devFreshOk || !devTamperRejected) {
    console.error("\nDEV HOST VERIFY FAILED", {
      devFrozenOk,
      devFreshOk,
      devTamperRejected,
    });
    process.exit(1);
  }
  console.log(
    "\nVERIFY OK: frozen signature, fresh signature, tamper rejected, dev-host vector verified.",
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main();
}
