import type { PgBoss } from "pg-boss";
import type { QueueConfig } from "./config.js";
import { loadQueueConfig } from "./config.js";
import { deadLetterQueueName, EVENT_NAMES, type EventName } from "./events.js";

export type EnsureQueuesOptions = {
  queueConfig?: QueueConfig;
  /** Override retry settings (tests). */
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
};

/**
 * Create primary queues and per-event dead-letter queues. Idempotent.
 * DLQ queues must exist before they are referenced by `deadLetter`.
 */
export async function ensureQueues(boss: PgBoss, options: EnsureQueuesOptions = {}): Promise<void> {
  const cfg = options.queueConfig ?? loadQueueConfig();
  const retryLimit = options.retryLimit ?? cfg.QUEUE_RETRY_LIMIT;
  const retryDelay = options.retryDelay ?? cfg.QUEUE_RETRY_DELAY_SECONDS;
  const retryBackoff = options.retryBackoff ?? cfg.QUEUE_RETRY_BACKOFF;
  const retryDelayMax = options.retryDelayMax ?? cfg.QUEUE_RETRY_DELAY_MAX_SECONDS;

  for (const name of EVENT_NAMES) {
    const dlq = deadLetterQueueName(name);
    await boss.createQueue(dlq, {
      // DLQ jobs are inspected / redriven manually; do not auto-retry forever.
      retryLimit: 0,
      deleteAfterSeconds: 60 * 60 * 24 * 30,
    });
    // createQueue is a no-op when the queue already exists; update options.
    await boss.updateQueue(dlq, {
      retryLimit: 0,
      deleteAfterSeconds: 60 * 60 * 24 * 30,
    });
    const primaryOptions = {
      policy: "standard" as const,
      retryLimit,
      retryDelay,
      retryBackoff,
      deadLetter: dlq,
      ...(retryBackoff ? { retryDelayMax } : {}),
    };
    await boss.createQueue(name, primaryOptions);
    await boss.updateQueue(name, {
      retryLimit,
      retryDelay,
      retryBackoff,
      deadLetter: dlq,
      ...(retryBackoff ? { retryDelayMax } : {}),
    });
  }
}

export function allQueueNames(): string[] {
  const names: string[] = [];
  for (const name of EVENT_NAMES) {
    names.push(name, deadLetterQueueName(name));
  }
  return names;
}

export function primaryQueueNames(): EventName[] {
  return [...EVENT_NAMES];
}
