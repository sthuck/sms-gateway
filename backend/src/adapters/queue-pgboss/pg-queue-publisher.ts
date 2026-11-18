import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type {
  PublishQueueOptions,
  QueueEventPayload,
  QueuePublisher,
} from "../../ports/outbound/queue-publisher.js";
import { publishInTx } from "./publish.js";
import type { QueueEvent } from "./events.js";

export class PgBossQueuePublisher implements QueuePublisher {
  constructor(private readonly boss: PgBoss) {}

  async publishInTx(
    tx: unknown,
    event: QueueEventPayload,
    options: PublishQueueOptions = {},
  ): Promise<string | null> {
    try {
      return await publishInTx(this.boss, tx as PoolClient, event as QueueEvent, options);
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "queue publish failed");
    }
  }
}
