import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { publishInTx } from "../queue/publish.js";
import { encryptBody } from "./encrypt-body.js";
import type { ValidatedMessage } from "./validate.js";

export type BatchItemResult =
  | { device_msg_id: string; status: "accepted"; id: string }
  | { device_msg_id: string; status: "duplicate"; id: string }
  | {
      device_msg_id: string;
      status: "rejected";
      error: { code: string; detail: string };
    };

export type PreparedItem =
  | { kind: "valid"; index: number; value: ValidatedMessage }
  | {
      kind: "rejected";
      index: number;
      deviceMsgId: string;
      code: string;
      detail: string;
    };

/**
 * Idempotent upsert of validated messages under the caller's `withOwner`
 * transaction. Uses `INSERT … ON CONFLICT DO NOTHING RETURNING` so concurrent
 * identical batches create each row (and publish each event) at most once.
 *
 * `ownerId` and `deviceId` come from the device credential only.
 */
export async function upsertMessagesInTx(
  boss: PgBoss,
  client: PoolClient,
  opts: {
    ownerId: string;
    deviceId: string;
    items: PreparedItem[];
  },
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(opts.items.length);

  for (const item of opts.items) {
    if (item.kind === "rejected") {
      results[item.index] = {
        device_msg_id: item.deviceMsgId,
        status: "rejected",
        error: { code: item.code, detail: item.detail },
      };
      continue;
    }

    const msg = item.value;
    // PLACEHOLDER (STH-20): identity encryptBody — never log plaintext/sender.
    const ciphertext = encryptBody(opts.ownerId, msg.body);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (
         owner_id, device_id, device_msg_id, sender, body_ciphertext,
         received_at, sim_slot, direction
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_id, device_msg_id) DO NOTHING
       RETURNING id`,
      [
        opts.ownerId,
        opts.deviceId,
        msg.deviceMsgId,
        msg.sender,
        ciphertext,
        msg.receivedAt.toISOString(),
        msg.simSlot,
        msg.direction,
      ],
    );

    if (inserted.rows[0]) {
      const id = inserted.rows[0].id;
      await publishInTx(boss, client, {
        type: "message.created",
        owner_id: opts.ownerId,
        message_id: id,
        device_id: opts.deviceId,
      });
      results[item.index] = {
        device_msg_id: msg.deviceMsgId,
        status: "accepted",
        id,
      };
      continue;
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM messages WHERE device_id = $1 AND device_msg_id = $2`,
      [opts.deviceId, msg.deviceMsgId],
    );
    const existingId = existing.rows[0]?.id;
    if (!existingId) {
      throw new Error("ON CONFLICT without existing row (unexpected)");
    }
    results[item.index] = {
      device_msg_id: msg.deviceMsgId,
      status: "duplicate",
      id: existingId,
    };
  }

  await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [opts.deviceId]);

  return results;
}
