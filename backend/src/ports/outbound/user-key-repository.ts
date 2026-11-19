/**
 * Per-user DEK rows under RLS (`withOwner`).
 *
 * DEKs are generated on first use (race-safe INSERT … ON CONFLICT DO NOTHING).
 * Infra failures MUST throw `InfrastructureError`.
 */
export type UserKeyRecord = {
  ownerId: string;
  wrappedDek: Uint8Array;
  kekId: string;
  dekVersion: number;
  createdAt: Date;
};

export type InsertUserKeyInput = {
  ownerId: string;
  wrappedDek: Uint8Array;
  kekId: string;
  dekVersion: number;
};

export type UserKeyRepository = {
  /**
   * Return the latest DEK for the owner, creating version 1 if none exist.
   * Concurrent first-use callers must end with exactly one version-1 row.
   */
  getOrCreateLatest(
    ownerId: string,
    create: () => Promise<Omit<InsertUserKeyInput, "ownerId" | "dekVersion">>,
  ): Promise<UserKeyRecord>;

  getByVersion(ownerId: string, dekVersion: number): Promise<UserKeyRecord | null>;

  listForOwner(ownerId: string): Promise<UserKeyRecord[]>;

  /** Insert a new dek_version (DEK rotation). Fails if the version already exists. */
  insertVersion(input: InsertUserKeyInput): Promise<UserKeyRecord>;

  /** Update wrapped_dek + kek_id for an existing row (KEK rotation re-wrap). */
  updateWrapped(
    ownerId: string,
    dekVersion: number,
    wrappedDek: Uint8Array,
    kekId: string,
  ): Promise<void>;

  /** Crypto-shred: delete all DEKs for the owner. */
  deleteAllForOwner(ownerId: string): Promise<number>;
};
