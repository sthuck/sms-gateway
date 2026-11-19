/**
 * Body encryption seam (STH-20).
 *
 * Stores AES-256-GCM envelope ciphertext in `messages.body_ciphertext`.
 * Callers must never log plaintext, DEKs, or wrapped keys.
 *
 * `deviceId` + `deviceMsgId` bind AAD to the row so ciphertext cannot be
 * moved to another message or owner.
 */
export type BodyCodecContext = {
  ownerId: string;
  deviceId: string;
  deviceMsgId: string;
};

export type BodyCodec = {
  encode(ctx: BodyCodecContext, plaintext: string): Promise<Uint8Array>;
  decode(ctx: BodyCodecContext, ciphertext: Uint8Array): Promise<string>;
};
