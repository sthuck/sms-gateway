/**
 * Body encryption write-path seam.
 *
 * STH-15 stores ciphertext bytes in `messages.body_ciphertext`. Real
 * per-user envelope encryption lands in STH-20. Until then this is an
 * **identity / passthrough** placeholder: UTF-8 plaintext → raw bytes.
 *
 * Callers must never log `plaintext` or the returned ciphertext.
 */
export function encryptBody(_ownerId: string, plaintext: string): Buffer {
  // PLACEHOLDER (STH-20): replace with envelope encryption. Identity for now.
  return Buffer.from(plaintext, "utf8");
}
