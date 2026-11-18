import type { Logger } from "pino";
import type { Pool, PoolClient } from "pg";
import type { Job, PgBoss } from "pg-boss";
import { withOwner } from "../adapters/db-postgres/with-owner.js";
import type { QueueConfig } from "./config.js";
import { loadQueueConfig } from "./config.js";
import { type EventName, type QueueEvent, parseQueueEvent } from "./events.js";
import { JOB_COMPLETED, JOB_DEAD_LETTERED, JOB_FAILED, type QueueMetrics } from "./metrics.js";

export type OwnerJobContext<E extends QueueEvent = QueueEvent> = {
  client: PoolClient;
  job: Job<E>;
  event: E;
  log: Logger;
};

export type OwnerJobHandler<E extends QueueEvent = QueueEvent> = (
  ctx: OwnerJobContext<E>,
) => Promise<void>;

export type RegisterOwnerHandlerOptions = {
  pool: Pool;
  log: Logger;
  metrics?: QueueMetrics;
  queueConfig?: QueueConfig;
  localConcurrency?: number;
  pollingIntervalSeconds?: number;
};

/**
 * Register a consumer that, for each job:
 * 1. Validates the ID-only payload
 * 2. Opens `withOwner(owner_id, …)` so RLS applies to handler DB work
 * 3. Updates metrics / structured logs
 *
 * Handlers must be idempotent: delivery is at-least-once. Use
 * `claimProcessed` (or `singletonKey` at publish time) for side effects.
 */
export async function registerOwnerHandler<E extends QueueEvent>(
  boss: PgBoss,
  queueName: EventName,
  handler: OwnerJobHandler<E>,
  options: RegisterOwnerHandlerOptions,
): Promise<string> {
  const cfg = options.queueConfig ?? loadQueueConfig();
  const pollingIntervalSeconds =
    options.pollingIntervalSeconds ?? cfg.QUEUE_POLLING_INTERVAL_SECONDS;
  const localConcurrency = options.localConcurrency ?? cfg.QUEUE_LOCAL_CONCURRENCY;

  return boss.work<E>(
    queueName,
    {
      pollingIntervalSeconds,
      localConcurrency,
    },
    async (jobs: Job<E>[]) => {
      const job = jobs[0];
      if (!job) {
        return;
      }

      const baseLog = options.log.child({
        queue: queueName,
        jobId: job.id,
        retryCount: job.retryCount,
      });

      let event: E;
      try {
        event = parseQueueEvent(job.data) as E;
      } catch (err) {
        options.metrics?.inc(JOB_FAILED, { queue: queueName, reason: "invalid_payload" });
        baseLog.error({ err }, "queue job payload failed validation");
        throw err;
      }

      const log = baseLog.child({
        ownerId: event.owner_id,
        eventType: event.type,
      });

      try {
        await withOwner(options.pool, event.owner_id, async (client) => {
          await handler({ client, job, event, log });
        });
        options.metrics?.inc(JOB_COMPLETED, { queue: queueName });
        log.info("queue job completed");
      } catch (err) {
        options.metrics?.inc(JOB_FAILED, { queue: queueName });
        log.warn({ err }, "queue job failed; will retry or dead-letter");
        throw err;
      }
    },
  );
}

/**
 * Register a no-op consumer on a dead-letter queue that logs and counts.
 * Does not rethrow — DLQ jobs stay completed after observation.
 */
export async function registerDeadLetterObserver(
  boss: PgBoss,
  queueName: string,
  options: { log: Logger; metrics?: QueueMetrics; pollingIntervalSeconds?: number },
): Promise<string> {
  return boss.work(
    queueName,
    {
      pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
    },
    async (jobs: Job[]) => {
      const job = jobs[0];
      if (!job) {
        return;
      }
      options.metrics?.inc(JOB_DEAD_LETTERED, { queue: queueName });
      options.log.error(
        {
          queue: queueName,
          jobId: job.id,
          data: job.data,
          retryCount: job.retryCount,
        },
        "job landed in dead-letter queue",
      );
    },
  );
}
