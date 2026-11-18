import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalString,
  encodeBase64Url,
  sha256HexBytes,
  signEs256P1363,
} from "../../src/device/signing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

export const testVector = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/contracts/examples/test-vector.json"), "utf8"),
) as {
  testPrivateKeyPkcs8Pem: string;
  testPublicKeySpkiB64url: string;
  testPublicKeySpkiPem: string;
  request: {
    body: string;
    headers: Record<string, string>;
  };
  frozenSignatureB64url: string;
  canonicalString: string;
  bodySha256Hex: string;
};

export function freshNonce(): string {
  return encodeBase64Url(randomBytes(16));
}

export type SignedRequest = {
  headers: Record<string, string>;
  body: string;
  canonical: string;
};

export function signDeviceRequest(opts: {
  method: string;
  path: string;
  host: string;
  deviceId: string;
  body?: string;
  privateKeyPem?: string;
  timestamp?: number;
  nonce?: string;
}): SignedRequest {
  const body = opts.body ?? "";
  const bodyBuf = Buffer.from(body, "utf8");
  const contentSha256 = sha256HexBytes(bodyBuf);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? freshNonce();
  const canonical = buildCanonicalString({
    method: opts.method,
    path: opts.path,
    query: "",
    host: opts.host,
    deviceId: opts.deviceId,
    timestamp,
    contentSha256,
    nonce,
  });
  const signature = signEs256P1363(
    canonical,
    opts.privateKeyPem ?? testVector.testPrivateKeyPkcs8Pem,
  );
  const headers: Record<string, string> = {
    host: opts.host,
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-content-sha256": contentSha256,
    "x-signature": signature,
  };
  if (opts.deviceId) {
    headers["x-device-id"] = opts.deviceId;
  }
  return { headers, body, canonical };
}
