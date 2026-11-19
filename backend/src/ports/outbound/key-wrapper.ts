/**
 * KEK (key-encryption key) port: wrap/unwrap per-user DEKs.
 *
 * File-based adapter for homelab/dev; Vault/cloud-KMS is a future adapter.
 * Failures MUST surface as `InfrastructureError` (never 4xx).
 */
export type WrapResult = {
  wrappedDek: Uint8Array;
  kekId: string;
};

export type KeyWrapper = {
  /** KEK id used for new wraps. */
  readonly activeKekId: string;

  wrap(dek: Uint8Array): Promise<WrapResult>;

  /**
   * Unwrap a DEK that was wrapped under `kekId` (active or previous).
   * Unknown/unavailable KEK → InfrastructureError.
   */
  unwrap(wrappedDek: Uint8Array, kekId: string): Promise<Uint8Array>;
};
