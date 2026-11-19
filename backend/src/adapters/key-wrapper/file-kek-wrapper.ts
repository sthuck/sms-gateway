import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { InfrastructureError } from "../../domain/errors.js";
import type { KeyWrapper, WrapResult } from "../../ports/outbound/key-wrapper.js";
import type { EncryptionConfig, PreviousKek } from "./config.js";

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function readKekFile(path: string, label: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new Error(
      `Encryption key file unreadable (${label}): ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw.length !== DEK_BYTES) {
    throw new Error(
      `Encryption key file must be exactly ${DEK_BYTES} bytes (${label}): ${path} has ${raw.length}`,
    );
  }
  return raw;
}

function wrapWithKey(kek: Buffer, dek: Uint8Array): Uint8Array {
  if (dek.length !== DEK_BYTES) {
    throw new InfrastructureError(`DEK must be ${DEK_BYTES} bytes`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(dek)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

function unwrapWithKey(kek: Buffer, wrapped: Uint8Array): Buffer {
  if (wrapped.length < NONCE_BYTES + TAG_BYTES + 1) {
    throw new InfrastructureError("Wrapped DEK is truncated");
  }
  const buf = Buffer.from(wrapped);
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new InfrastructureError("Failed to unwrap DEK with KEK", { cause: err });
  }
}

/**
 * File-based KEK adapter. Reads 32-byte keys from configured paths at construct
 * time so startup fails fast when encryption is enabled and keys are missing.
 */
export class FileKekWrapper implements KeyWrapper {
  readonly activeKekId: string;
  private readonly keys: Map<string, Buffer>;

  constructor(options: {
    activeKekId: string;
    activeKek: Buffer;
    previous?: Array<{ kekId: string; key: Buffer }>;
  }) {
    this.activeKekId = options.activeKekId;
    this.keys = new Map([[options.activeKekId, options.activeKek]]);
    for (const prev of options.previous ?? []) {
      if (prev.kekId === options.activeKekId) {
        throw new Error(`Previous KEK id collides with active id "${prev.kekId}"`);
      }
      this.keys.set(prev.kekId, prev.key);
    }
  }

  static fromConfig(config: EncryptionConfig): FileKekWrapper {
    if (!config.kekFile) {
      throw new Error("FileKekWrapper requires KEK_FILE");
    }
    const activeKek = readKekFile(config.kekFile, `active ${config.kekId}`);
    const previous = config.previousKeks.map((p: PreviousKek) => ({
      kekId: p.kekId,
      key: readKekFile(p.filePath, `previous ${p.kekId}`),
    }));
    return new FileKekWrapper({
      activeKekId: config.kekId,
      activeKek,
      previous,
    });
  }

  async wrap(dek: Uint8Array): Promise<WrapResult> {
    const kek = this.keys.get(this.activeKekId);
    if (!kek) {
      throw new InfrastructureError(`Active KEK "${this.activeKekId}" is not loaded`);
    }
    try {
      return { wrappedDek: wrapWithKey(kek, dek), kekId: this.activeKekId };
    } catch (err) {
      if (err instanceof InfrastructureError) throw err;
      throw new InfrastructureError("KEK wrap failed", { cause: err });
    }
  }

  async unwrap(wrappedDek: Uint8Array, kekId: string): Promise<Uint8Array> {
    const kek = this.keys.get(kekId);
    if (!kek) {
      throw new InfrastructureError(`KEK "${kekId}" is not available for unwrap`);
    }
    try {
      return unwrapWithKey(kek, wrappedDek);
    } catch (err) {
      if (err instanceof InfrastructureError) throw err;
      throw new InfrastructureError("KEK unwrap failed", { cause: err });
    }
  }
}
