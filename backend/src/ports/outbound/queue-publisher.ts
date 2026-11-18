/**
 * Outbound queue publish port (pg-boss under the hood).
 *
 * - Infra failures (pg-boss / DB) MUST throw `InfrastructureError`.
 * - Return `null` only when the underlying send legitimately returns null
 *   (e.g. singletonKey already queued) — never for errors.
 */
export type QueueEventPayload = {
  type: string;
  owner_id: string;
  [key: string]: unknown;
};

export type PublishQueueOptions = {
  singletonKey?: string;
  startAfter?: number;
};

export type QueuePublisher = {
  /**
   * Publish using the caller's open DB transaction client.
   * `tx` is intentionally opaque (PoolClient) so ports stay free of `pg` types
   * in the interface surface beyond `unknown`.
   */
  publishInTx(
    tx: unknown,
    event: QueueEventPayload,
    options?: PublishQueueOptions,
  ): Promise<string | null>;
};
