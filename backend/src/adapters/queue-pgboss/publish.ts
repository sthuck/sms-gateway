import type { PoolClient } from "pg";
import { type PgBoss, type SendOptions } from "pg-boss";
import { fromPoolClient } from "./db-adapter.js";
import { type EventName, type QueueEvent, isEventName, parseQueueEvent } from "./events.js";

export type PublishInTxOptions = {
  /** Optional enqueue-time dedupe within pg-boss (one queued job per key). */
  singletonKey?: string;
  /** Override start delay (seconds) — mainly for tests. */
  startAfter?: number;
};

/**
 * Insert a typed queue event using the caller's open transaction.
 *
 * If the transaction rolls back, the job row is rolled back too (pg-boss
 * `{ db }` adapter). Prefer this over a separate outbox whenever the same
 * Postgres database holds both app data and the queue.
 */
export async function publishInTx(
  boss: PgBoss,
  tx: PoolClient,
  event: QueueEvent,
  options: PublishInTxOptions = {},
): Promise<string | null> {
  const parsed = parseQueueEvent(event);
  if (!isEventName(parsed.type)) {
    throw new Error(`Unknown event type: ${String((event as { type?: unknown }).type)}`);
  }

  const name: EventName = parsed.type;
  const sendOptions: SendOptions = {
    db: fromPoolClient(tx),
  };
  if (options.singletonKey !== undefined) {
    sendOptions.singletonKey = options.singletonKey;
  }
  if (options.startAfter !== undefined) {
    sendOptions.startAfter = options.startAfter;
  }

  return boss.send(name, parsed, sendOptions);
}
