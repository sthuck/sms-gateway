import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { UserKeyRepository } from "../../ports/outbound/user-key-repository.js";
import type { UserRepository } from "../../ports/outbound/user-repository.js";

/**
 * Minimal crypto-shred / account wipe (no HTTP route).
 *
 * Deletes DEKs first so any residual ciphertext (backups included) becomes
 * undecryptable, then deletes the user row (CASCADE removes owned data).
 */
export type DeleteUserDataDeps = {
  userKeys: UserKeyRepository;
  users: UserRepository;
  invalidateCache?: (ownerId: string) => void;
};

export type DeleteUserDataResult = {
  keysDeleted: number;
  userDeleted: boolean;
};

export class DeleteUserData {
  constructor(private readonly deps: DeleteUserDataDeps) {}

  async execute(ownerId: string): Promise<DeleteUserDataResult> {
    try {
      const keysDeleted = await this.deps.userKeys.deleteAllForOwner(ownerId);
      this.deps.invalidateCache?.(ownerId);
      const userDeleted = await this.deps.users.deleteById(ownerId);
      return { keysDeleted, userDeleted };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "delete user data failed");
    }
  }
}
