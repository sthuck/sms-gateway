import type { PoolClient, QueryResult } from "pg";
import type { Db } from "pg-boss";

/**
 * Adapt a node-pg `PoolClient` (already inside a transaction) so pg-boss can
 * insert jobs with `{ db }` and share the caller's commit/rollback.
 */
export function fromPoolClient(client: PoolClient): Db {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const result = await client.query(text, values ?? []);
      if (Array.isArray(result)) {
        return { rows: (result as QueryResult[]).flatMap((r) => r.rows) };
      }
      return { rows: result.rows };
    },
  };
}
