/**
 * Body encryption seam (Phase 2 / STH-20).
 *
 * STH-15 stores bytes in `messages.body_ciphertext`. Until envelope
 * encryption lands, production uses an identity / passthrough codec
 * (UTF-8 plaintext ↔ raw bytes). Callers must never log plaintext.
 */
export type BodyCodec = {
  encode(ownerId: string, plaintext: string): Uint8Array;
  decode(ownerId: string, ciphertext: Uint8Array): string;
};
