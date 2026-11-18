import type { Pool, PoolClient } from "pg";

export type WithOwnerFn<T> = (client: PoolClient) => Promise<T>;

/**
 * Run `fn` inside a transaction with `app.owner_id` set via
 * `set_config(..., true)` so the setting is transaction-local and cannot
 * leak to the next borrower of the pooled connection.
 *
 * RLS policies use `app.current_owner_id()` which reads this setting.
 */
export async function withOwner<T>(pool: Pool, ownerId: string, fn: WithOwnerFn<T>): Promise<T> {
  if (!ownerId) {
    throw new Error("withOwner requires a non-empty ownerId");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
