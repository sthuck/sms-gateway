import type { PoolClient } from "pg";

export type ClaimProcessedParams = {
  ownerId: string;
  /** Stable key for the side effect, e.g. `message.created:${message_id}`. */
  dedupeKey: string;
  jobName: string;
  jobId?: string;
};

/**
 * Claim a dedupe key inside the caller's `withOwner` transaction.
 *
 * Pattern for idempotent handlers (at-least-once delivery):
 * 1. `const { claimed } = await claimProcessed(client, …)`
 * 2. If `!claimed`, return successfully (already applied).
 * 3. Otherwise perform the side effect in the same transaction.
 *
 * Prefer this for handler-level effects. For enqueue-time dedupe of identical
 * jobs, also pass `singletonKey` to `publishInTx` / `boss.send`.
 */
export async function claimProcessed(
  client: PoolClient,
  params: ClaimProcessedParams,
): Promise<{ claimed: boolean }> {
  const result = await client.query<{ dedupe_key: string }>(
    `INSERT INTO queue_processed_jobs (owner_id, dedupe_key, job_name, job_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [params.ownerId, params.dedupeKey, params.jobName, params.jobId ?? null],
  );
  return { claimed: (result.rowCount ?? 0) > 0 };
}

export function messageCreatedDedupeKey(messageId: string): string {
  return `message.created:${messageId}`;
}

export function streamReclassifyDedupeKey(streamId: string, version?: number): string {
  return version === undefined
    ? `stream.reclassify:${streamId}`
    : `stream.reclassify:${streamId}:v${version}`;
}
