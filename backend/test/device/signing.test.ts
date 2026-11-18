import { describe, expect, it } from "vitest";
import {
  buildCanonicalString,
  parsePublicKeySpkiB64url,
  sha256HexBytes,
  signEs256P1363,
  verifyEs256P1363,
} from "../../src/device/signing.js";
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
} from "../../src/device/pairing-code.js";
import { testVector } from "../helpers/device-signing.js";

describe("device signing", () => {
  it("matches the shared test vector body hash and canonical string", () => {
    const bodyHash = sha256HexBytes(Buffer.from(testVector.request.body, "utf8"));
    expect(bodyHash).toBe(testVector.bodySha256Hex);
    expect(testVector.canonicalString.split("\n")).toHaveLength(9);
    expect(testVector.canonicalString.endsWith("\n")).toBe(false);
  });

  it("verifies the frozen P1363 signature and a fresh signature", () => {
    const key = parsePublicKeySpkiB64url(testVector.testPublicKeySpkiB64url)!;
    expect(
      verifyEs256P1363(testVector.canonicalString, testVector.frozenSignatureB64url, key),
    ).toBe(true);

    const fresh = signEs256P1363(testVector.canonicalString, testVector.testPrivateKeyPkcs8Pem);
    expect(verifyEs256P1363(testVector.canonicalString, fresh, key)).toBe(true);

    const tampered = testVector.canonicalString.replace(/^v1/, "v2");
    expect(verifyEs256P1363(tampered, testVector.frozenSignatureB64url, key)).toBe(false);
  });

  it("builds the nine-field canonical string without a trailing newline", () => {
    const s = buildCanonicalString({
      method: "post",
      path: "/v1/devices/me",
      query: "",
      host: "10.0.2.2:8080",
      deviceId: "018f3c2a-9b4d-7e21-a456-426614174000",
      timestamp: "1794995160",
      contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      nonce: "V1nQe4r0sK8mP2yL6dF9TQ",
    });
    expect(s.startsWith("v1\nPOST\n")).toBe(true);
    expect(s.endsWith("\n")).toBe(false);
  });
});

describe("pairing codes", () => {
  it("generates Crockford codes and normalizes case/hyphen", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-HJ-NP-TV-Z0-9]{4}-[A-HJ-NP-TV-Z0-9]{4}$/);
    const norm = normalizePairingCode(code.toLowerCase())!;
    expect(norm).toHaveLength(8);
    expect(hashPairingCode(norm)).toHaveLength(64);
    expect(normalizePairingCode("IIII-IIII")).toBeNull();
  });
});
