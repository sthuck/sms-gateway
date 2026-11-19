import type { Pool, PoolClient } from "pg";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type {
  MessageInsert,
  MessageRepository,
  MessageUpsertRow,
} from "../../ports/outbound/message-repository.js";
import type { QueuePublisher } from "../../ports/outbound/queue-publisher.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

export class PgMessageRepository implements MessageRepository {
  constructor(
    private readonly pool: Pool,
    private readonly queue: QueuePublisher,
  ) {}

  upsertBatch(input: {
    ownerId: string;
    deviceId: string;
    messages: MessageInsert[];
  }): Promise<MessageUpsertRow[]> {
    return withDbInfra("message batch upsert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const results: MessageUpsertRow[] = [];

        for (const msg of input.messages) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO messages (
               owner_id, device_id, device_msg_id, sender, body_ciphertext,
               received_at, sim_slot, direction
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (device_id, device_msg_id) DO NOTHING
             RETURNING id`,
            [
              input.ownerId,
              input.deviceId,
              msg.deviceMsgId,
              msg.sender,
              Buffer.from(msg.bodyCiphertext),
              msg.receivedAt.toISOString(),
              msg.simSlot,
              msg.direction,
            ],
          );

          if (inserted.rows[0]) {
            const id = inserted.rows[0].id;
            await this.publishCreated(client, {
              ownerId: input.ownerId,
              deviceId: input.deviceId,
              messageId: id,
            });
            results.push({ deviceMsgId: msg.deviceMsgId, status: "accepted", id });
            continue;
          }

          const existing = await client.query<{ id: string }>(
            `SELECT id FROM messages WHERE device_id = $1 AND device_msg_id = $2`,
            [input.deviceId, msg.deviceMsgId],
          );
          const existingId = existing.rows[0]?.id;
          if (!existingId) {
            throw new InfrastructureError("ON CONFLICT without existing message row (unexpected)");
          }
          results.push({
            deviceMsgId: msg.deviceMsgId,
            status: "duplicate",
            id: existingId,
          });
        }

        await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [
          input.deviceId,
        ]);

        return results;
      }),
    );
  }

  private async publishCreated(
    client: PoolClient,
    opts: { ownerId: string; deviceId: string; messageId: string },
  ): Promise<void> {
    try {
      await this.queue.publishInTx(client, {
        type: "message.created",
        owner_id: opts.ownerId,
        message_id: opts.messageId,
        device_id: opts.deviceId,
      });
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "message.created publish failed");
    }
  }
}
