import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type { KeyWrapper } from "../../ports/outbound/key-wrapper.js";
import type { MessageRepository } from "../../ports/outbound/message-repository.js";
import type { UserKeyRepository } from "../../ports/outbound/user-key-repository.js";

export type RotateDekDeps = {
  userKeys: UserKeyRepository;
  keyWrapper: KeyWrapper;
  messages: MessageRepository;
  bodyCodec: BodyCodec;
  /** CSPRNG for a fresh 32-byte DEK (injected; keeps crypto out of application). */
  generateDek: () => Uint8Array;
  /** Optional: seed cache with the freshly generated DEK. */
  cacheDek?: (ownerId: string, dekVersion: number, dek: Uint8Array) => void;
};

/**
 * Create a new dek_version for the owner. Old versions are kept so existing
 * ciphertext still decrypts until re-encrypt moves rows forward.
 */
export async function rotateDekForOwner(
  ownerId: string,
  deps: RotateDekDeps,
): Promise<{ dekVersion: number }> {
  try {
    const existing = await deps.userKeys.listForOwner(ownerId);
    const latest = existing.reduce((max, row) => Math.max(max, row.dekVersion), 0);
    const nextVersion = latest + 1;
    const dek = deps.generateDek();
    const wrapped = await deps.keyWrapper.wrap(dek);
    await deps.userKeys.insertVersion({
      ownerId,
      wrappedDek: wrapped.wrappedDek,
      kekId: wrapped.kekId,
      dekVersion: nextVersion,
    });
    deps.cacheDek?.(ownerId, nextVersion, dek);
    return { dekVersion: nextVersion };
  } catch (err) {
    if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
    throw InfrastructureError.wrap(err, "DEK rotation failed");
  }
}

export type ReencryptMessagesResult = {
  processed: number;
  updated: number;
  done: boolean;
  afterId: string | null;
};

/**
 * Re-encrypt message bodies under the owner's latest DEK, in id-ordered batches.
 * Safe to resume via `afterId`.
 */
export async function reencryptMessagesForOwner(
  ownerId: string,
  deps: RotateDekDeps,
  opts?: { batchSize?: number; afterId?: string },
): Promise<ReencryptMessagesResult> {
  const batchSize = opts?.batchSize ?? 100;
  try {
    const batch = await deps.messages.listCiphertextBatch(
      ownerId,
      opts?.afterId ? { limit: batchSize, afterId: opts.afterId } : { limit: batchSize },
    );
    let updated = 0;
    for (const row of batch) {
      const ctx = {
        ownerId: row.ownerId,
        deviceId: row.deviceId,
        deviceMsgId: row.deviceMsgId,
      };
      const plaintext = await deps.bodyCodec.decode(ctx, row.bodyCiphertext);
      const nextCiphertext = await deps.bodyCodec.encode(ctx, plaintext);
      const ok = await deps.messages.updateCiphertext(ownerId, row.id, nextCiphertext);
      if (ok) updated += 1;
    }
    const last = batch[batch.length - 1];
    return {
      processed: batch.length,
      updated,
      done: batch.length < batchSize,
      afterId: last?.id ?? opts?.afterId ?? null,
    };
  } catch (err) {
    if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
    throw InfrastructureError.wrap(err, "DEK re-encrypt failed");
  }
}
