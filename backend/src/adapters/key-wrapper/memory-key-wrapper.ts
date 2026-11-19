import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InfrastructureError } from "../../domain/errors.js";
import type { KeyWrapper, WrapResult } from "../../ports/outbound/key-wrapper.js";

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * In-memory KEK for unit/integration tests. Supports fault injection to
 * simulate KMS/KEK outages (InfrastructureError).
 */
export class MemoryKeyWrapper implements KeyWrapper {
  private _activeKekId: string;
  /** When true, wrap/unwrap throw InfrastructureError (KEK outage). */
  unavailable = false;
  private readonly keys: Map<string, Buffer>;

  constructor(options?: { activeKekId?: string; activeKek?: Buffer }) {
    this._activeKekId = options?.activeKekId ?? "test-kek";
    const active = options?.activeKek ?? randomBytes(DEK_BYTES);
    if (active.length !== DEK_BYTES) {
      throw new Error(`MemoryKeyWrapper KEK must be ${DEK_BYTES} bytes`);
    }
    this.keys = new Map([[this._activeKekId, active]]);
  }

  get activeKekId(): string {
    return this._activeKekId;
  }

  addPrevious(kekId: string, key: Buffer = randomBytes(DEK_BYTES)): void {
    if (key.length !== DEK_BYTES) {
      throw new Error(`MemoryKeyWrapper KEK must be ${DEK_BYTES} bytes`);
    }
    this.keys.set(kekId, key);
  }

  /** Rotate: keep old key for unwrap and install a new active key. */
  rotateActive(newKekId: string, newKey: Buffer = randomBytes(DEK_BYTES)): void {
    if (newKey.length !== DEK_BYTES) {
      throw new Error(`MemoryKeyWrapper KEK must be ${DEK_BYTES} bytes`);
    }
    this.keys.set(newKekId, newKey);
    this._activeKekId = newKekId;
  }

  /** Drop a KEK from the map (simulates retiring an old KEK after re-wrap). */
  dropKek(kekId: string): void {
    this.keys.delete(kekId);
  }

  async wrap(dek: Uint8Array): Promise<WrapResult> {
    if (this.unavailable) {
      throw new InfrastructureError("KEK unavailable (test fault)");
    }
    if (dek.length !== DEK_BYTES) {
      throw new InfrastructureError(`DEK must be ${DEK_BYTES} bytes`);
    }
    const kek = this.keys.get(this._activeKekId);
    if (!kek) {
      throw new InfrastructureError(`Active KEK "${this._activeKekId}" is not loaded`);
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(dek)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      wrappedDek: Buffer.concat([nonce, ciphertext, tag]),
      kekId: this._activeKekId,
    };
  }

  async unwrap(wrappedDek: Uint8Array, kekId: string): Promise<Uint8Array> {
    if (this.unavailable) {
      throw new InfrastructureError("KEK unavailable (test fault)");
    }
    const kek = this.keys.get(kekId);
    if (!kek) {
      throw new InfrastructureError(`KEK "${kekId}" is not available for unwrap`);
    }
    const buf = Buffer.from(wrappedDek);
    if (buf.length < NONCE_BYTES + TAG_BYTES + 1) {
      throw new InfrastructureError("Wrapped DEK is truncated");
    }
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
}
