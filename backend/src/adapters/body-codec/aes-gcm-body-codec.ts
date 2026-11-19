import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptionError, InfrastructureError } from "../../domain/errors.js";
import type { BodyCodec, BodyCodecContext } from "../../ports/outbound/body-codec.js";
import type { KeyWrapper } from "../../ports/outbound/key-wrapper.js";
import type { UserKeyRepository } from "../../ports/outbound/user-key-repository.js";
import type { DekCache } from "./dek-cache.js";

/** Envelope format version byte. */
export const BODY_BLOB_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
/** version(1) + dek_version(2) + nonce(12) */
const HEADER_BYTES = 1 + 2 + NONCE_BYTES;

export type AesGcmBodyCodecDeps = {
  keyWrapper: KeyWrapper;
  userKeys: UserKeyRepository;
  cache: DekCache;
};

function buildAad(ctx: BodyCodecContext): Buffer {
  return Buffer.from(`${ctx.ownerId}\0${ctx.deviceId}\0${ctx.deviceMsgId}`, "utf8");
}

function packBlob(dekVersion: number, nonce: Buffer, ciphertextAndTag: Buffer): Buffer {
  if (dekVersion < 1 || dekVersion > 0xffff) {
    throw new InfrastructureError(`dek_version out of range: ${dekVersion}`);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(BODY_BLOB_VERSION, 0);
  header.writeUInt16BE(dekVersion, 1);
  nonce.copy(header, 3);
  return Buffer.concat([header, ciphertextAndTag]);
}

function parseBlob(blob: Uint8Array): {
  dekVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  // Empty plaintext is valid: header + tag only (zero-length ciphertext).
  if (blob.length < HEADER_BYTES + TAG_BYTES) {
    throw new DecryptionError("Ciphertext blob is truncated");
  }
  const buf = Buffer.from(blob);
  const version = buf.readUInt8(0);
  if (version !== BODY_BLOB_VERSION) {
    throw new DecryptionError(`Unsupported ciphertext format version ${version}`);
  }
  const dekVersion = buf.readUInt16BE(1);
  const nonce = buf.subarray(3, 3 + NONCE_BYTES);
  const body = buf.subarray(HEADER_BYTES);
  if (body.length < TAG_BYTES) {
    throw new DecryptionError("Ciphertext blob is truncated");
  }
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  return { dekVersion, nonce, ciphertext, tag };
}

/**
 * AES-256-GCM body codec with per-user DEKs wrapped by a KEK.
 *
 * Blob layout: `version(1) | dek_version(2 BE) | nonce(12) | ciphertext|tag`.
 * AAD binds ciphertext to owner_id + device_id + device_msg_id.
 */
export class AesGcmBodyCodec implements BodyCodec {
  constructor(private readonly deps: AesGcmBodyCodecDeps) {}

  async encode(ctx: BodyCodecContext, plaintext: string): Promise<Uint8Array> {
    try {
      const { dek, dekVersion } = await this.resolveLatestDek(ctx.ownerId);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", dek, nonce);
      cipher.setAAD(buildAad(ctx));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return packBlob(dekVersion, nonce, Buffer.concat([ciphertext, tag]));
    } catch (err) {
      if (err instanceof InfrastructureError || err instanceof DecryptionError) throw err;
      throw new InfrastructureError("Body encryption failed", { cause: err });
    }
  }

  async decode(ctx: BodyCodecContext, ciphertext: Uint8Array): Promise<string> {
    let parsed: ReturnType<typeof parseBlob>;
    try {
      parsed = parseBlob(ciphertext);
    } catch (err) {
      if (err instanceof DecryptionError) throw err;
      throw new DecryptionError("Invalid ciphertext blob", { cause: err });
    }

    let dek: Buffer;
    try {
      dek = await this.resolveDekVersion(ctx.ownerId, parsed.dekVersion);
    } catch (err) {
      if (err instanceof InfrastructureError || err instanceof DecryptionError) throw err;
      throw new InfrastructureError("DEK load failed", { cause: err });
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", dek, parsed.nonce);
      decipher.setAAD(buildAad(ctx));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new DecryptionError("Ciphertext authentication failed", { cause: err });
    }
  }

  private async resolveLatestDek(ownerId: string): Promise<{ dek: Buffer; dekVersion: number }> {
    const record = await this.deps.userKeys.getOrCreateLatest(ownerId, async () => {
      const dek = randomBytes(DEK_BYTES);
      const wrapped = await this.deps.keyWrapper.wrap(dek);
      return { wrappedDek: wrapped.wrappedDek, kekId: wrapped.kekId };
    });

    const cached = this.deps.cache.get(ownerId, record.dekVersion);
    if (cached) {
      return { dek: cached, dekVersion: record.dekVersion };
    }

    const dek = Buffer.from(await this.deps.keyWrapper.unwrap(record.wrappedDek, record.kekId));
    if (dek.length !== DEK_BYTES) {
      throw new InfrastructureError("Unwrapped DEK has unexpected length");
    }
    this.deps.cache.set(ownerId, record.dekVersion, dek);
    return { dek, dekVersion: record.dekVersion };
  }

  private async resolveDekVersion(ownerId: string, dekVersion: number): Promise<Buffer> {
    const cached = this.deps.cache.get(ownerId, dekVersion);
    if (cached) return cached;

    const record = await this.deps.userKeys.getByVersion(ownerId, dekVersion);
    if (!record) {
      throw new DecryptionError(`DEK version ${dekVersion} not found for owner`);
    }

    const dek = Buffer.from(await this.deps.keyWrapper.unwrap(record.wrappedDek, record.kekId));
    if (dek.length !== DEK_BYTES) {
      throw new InfrastructureError("Unwrapped DEK has unexpected length");
    }
    this.deps.cache.set(ownerId, dekVersion, dek);
    return dek;
  }
}
