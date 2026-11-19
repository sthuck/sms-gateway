import type { Pool, PoolClient } from "pg";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { MessageDirection } from "../../domain/message/types.js";
import type {
  MessageInsert,
  MessageListInput,
  MessageRecord,
  MessageRepository,
  MessageUpsertRow,
} from "../../ports/outbound/message-repository.js";
import type { QueuePublisher } from "../../ports/outbound/queue-publisher.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

type MessageRow = {
  id: string;
  owner_id: string;
  device_id: string;
  device_msg_id: string;
  sender: string;
  body_ciphertext: Buffer;
  received_at: Date;
  sim_slot: number | null;
  direction: MessageDirection;
};

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    deviceId: row.device_id,
    deviceMsgId: row.device_msg_id,
    sender: row.sender,
    bodyCiphertext: new Uint8Array(row.body_ciphertext),
    receivedAt: row.received_at,
    simSlot: row.sim_slot,
    direction: row.direction,
  };
}

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

  listRecent(ownerId: string, limit: number): Promise<MessageRecord[]> {
    return withDbInfra("message list recent failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<MessageRow>(
          `SELECT id, owner_id, device_id, device_msg_id, sender, body_ciphertext,
                  received_at, sim_slot, direction
           FROM messages
           ORDER BY received_at DESC, id DESC
           LIMIT $1`,
          [limit],
        );
        return rows.map(mapMessageRow);
      }),
    );
  }

  list(input: MessageListInput): Promise<MessageRecord[]> {
    return withDbInfra("message list failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const params: unknown[] = [];
        const where: string[] = [];

        if (input.filters?.deviceId) {
          params.push(input.filters.deviceId);
          where.push(`device_id = $${params.length}`);
        }
        if (input.filters?.sender) {
          params.push(input.filters.sender);
          where.push(`sender = $${params.length}`);
        }
        if (input.filters?.receivedAfter) {
          params.push(input.filters.receivedAfter.toISOString());
          where.push(`received_at >= $${params.length}::timestamptz`);
        }
        if (input.filters?.receivedBefore) {
          params.push(input.filters.receivedBefore.toISOString());
          where.push(`received_at <= $${params.length}::timestamptz`);
        }
        if (input.cursor) {
          params.push(input.cursor.receivedAt.toISOString(), input.cursor.id);
          where.push(
            `(received_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }

        params.push(input.limit);
        const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const { rows } = await client.query<MessageRow>(
          `SELECT id, owner_id, device_id, device_msg_id, sender, body_ciphertext,
                  received_at, sim_slot, direction
           FROM messages
           ${whereSql}
           ORDER BY received_at DESC, id DESC
           LIMIT $${params.length}`,
          params,
        );
        return rows.map(mapMessageRow);
      }),
    );
  }

  findById(ownerId: string, messageId: string): Promise<MessageRecord | null> {
    return withDbInfra("message find failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<MessageRow>(
          `SELECT id, owner_id, device_id, device_msg_id, sender, body_ciphertext,
                  received_at, sim_slot, direction
           FROM messages
           WHERE id = $1`,
          [messageId],
        );
        const row = rows[0];
        return row ? mapMessageRow(row) : null;
      }),
    );
  }

  delete(ownerId: string, messageId: string): Promise<boolean> {
    return withDbInfra("message delete failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const result = await client.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
        return (result.rowCount ?? 0) > 0;
      }),
    );
  }

  listCiphertextBatch(
    ownerId: string,
    opts: { limit: number; afterId?: string },
  ): Promise<MessageRecord[]> {
    return withDbInfra("message ciphertext batch failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const params: unknown[] = [opts.limit];
        let afterClause = "";
        if (opts.afterId) {
          params.push(opts.afterId);
          afterClause = `WHERE id > $2`;
        }
        const { rows } = await client.query<MessageRow>(
          `SELECT id, owner_id, device_id, device_msg_id, sender, body_ciphertext,
                  received_at, sim_slot, direction
           FROM messages
           ${afterClause}
           ORDER BY id ASC
           LIMIT $1`,
          params,
        );
        return rows.map(mapMessageRow);
      }),
    );
  }

  updateCiphertext(
    ownerId: string,
    messageId: string,
    bodyCiphertext: Uint8Array,
  ): Promise<boolean> {
    return withDbInfra("message ciphertext update failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const result = await client.query(
          `UPDATE messages SET body_ciphertext = $1 WHERE id = $2`,
          [Buffer.from(bodyCiphertext), messageId],
        );
        return (result.rowCount ?? 0) > 0;
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
