import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { KeyWrapper } from "../../ports/outbound/key-wrapper.js";
import type { UserKeyRepository } from "../../ports/outbound/user-key-repository.js";

export type RotateKekDeps = {
  userKeys: UserKeyRepository;
  keyWrapper: KeyWrapper;
  /** Optional cache invalidation after re-wrap. */
  invalidateCache?: (ownerId: string) => void;
};

/**
 * Re-wrap all DEKs for one owner under the active KEK.
 * Message ciphertext rows are not touched.
 */
export async function rotateKekForOwner(
  ownerId: string,
  deps: RotateKekDeps,
): Promise<{ rewrapped: number; kekId: string }> {
  try {
    const rows = await deps.userKeys.listForOwner(ownerId);
    let rewrapped = 0;
    for (const row of rows) {
      if (row.kekId === deps.keyWrapper.activeKekId) {
        continue;
      }
      const dek = await deps.keyWrapper.unwrap(row.wrappedDek, row.kekId);
      const wrapped = await deps.keyWrapper.wrap(dek);
      await deps.userKeys.updateWrapped(ownerId, row.dekVersion, wrapped.wrappedDek, wrapped.kekId);
      rewrapped += 1;
    }
    deps.invalidateCache?.(ownerId);
    return { rewrapped, kekId: deps.keyWrapper.activeKekId };
  } catch (err) {
    if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
    throw InfrastructureError.wrap(err, "KEK rotation failed");
  }
}
