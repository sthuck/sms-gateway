import type { BodyCodec } from "../../ports/outbound/body-codec.js";

/**
 * PLACEHOLDER (STH-20): identity / passthrough until envelope encryption.
 * UTF-8 plaintext → raw bytes. Never log plaintext or ciphertext.
 */
export class IdentityBodyCodec implements BodyCodec {
  encode(_ownerId: string, plaintext: string): Uint8Array {
    return Buffer.from(plaintext, "utf8");
  }
}
