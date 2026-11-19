import type { BodyCodec, BodyCodecContext } from "../../ports/outbound/body-codec.js";

/**
 * Passthrough codec (UTF-8 plaintext ↔ raw bytes).
 * Used only when ENCRYPTION_ENABLED=false (local/dev escape hatch).
 */
export class IdentityBodyCodec implements BodyCodec {
  async encode(_ctx: BodyCodecContext, plaintext: string): Promise<Uint8Array> {
    return Buffer.from(plaintext, "utf8");
  }

  async decode(_ctx: BodyCodecContext, ciphertext: Uint8Array): Promise<string> {
    return Buffer.from(ciphertext).toString("utf8");
  }
}
