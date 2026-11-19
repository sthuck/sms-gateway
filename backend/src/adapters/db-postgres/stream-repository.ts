import type { Pool, PoolClient } from "pg";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { MessageDirection } from "../../domain/message/types.js";
import type {
  Stream,
  StreamBackfillStatus,
  StreamMode,
  StreamRule,
} from "../../domain/stream/types.js";
import type {
  InsertStreamInput,
  ListStreamMessagesInput,
  ListStreamMessagesResult,
  StreamMatchedBy,
  StreamMessageRecord,
  StreamRepository,
  UpdateStreamPatch,
} from "../../ports/outbound/stream-repository.js";
import type { QueuePublisher } from "../../ports/outbound/queue-publisher.js";
import { withDbInfra } from "./infra.js";
import { withOwner } from "./with-owner.js";

type StreamRow = {
  id: string;
  owner_id: string;
  name: string;
  mode: StreamMode;
  rules_json: StreamRule[];
  ai_prompt: string | null;
  version: number;
  backfill_status: StreamBackfillStatus;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: StreamRow): Stream {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    mode: row.mode,
    rulesJson: row.rules_json,
    aiPrompt: row.ai_prompt,
    version: row.version,
    backfillStatus: row.backfill_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class PgStreamRepository implements StreamRepository {
  constructor(
    private readonly pool: Pool,
    private readonly queue: QueuePublisher,
  ) {}

  insert(input: InsertStreamInput): Promise<Stream> {
    return withDbInfra("stream insert failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const { rows } = await client.query<StreamRow>(
          `INSERT INTO streams (owner_id, name, mode, rules_json, ai_prompt)
           VALUES (app.current_owner_id(), $1, $2, $3::jsonb, $4)
           RETURNING id, owner_id, name, mode, rules_json, ai_prompt, version,
                     backfill_status, created_at, updated_at`,
          [input.name, input.mode, JSON.stringify(input.rulesJson), input.aiPrompt],
        );
        return mapRow(rows[0]!);
      }),
    );
  }

  list(ownerId: string, limit: number): Promise<Stream[]> {
    return withDbInfra("stream list failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<StreamRow>(
          `SELECT id, owner_id, name, mode, rules_json, ai_prompt, version,
                  backfill_status, created_at, updated_at
           FROM streams
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit],
        );
        return rows.map(mapRow);
      }),
    );
  }

  findById(ownerId: string, streamId: string): Promise<Stream | null> {
    return withDbInfra("stream lookup failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const { rows } = await client.query<StreamRow>(
          `SELECT id, owner_id, name, mode, rules_json, ai_prompt, version,
                  backfill_status, created_at, updated_at
           FROM streams
           WHERE id = $1`,
          [streamId],
        );
        const row = rows[0];
        return row ? mapRow(row) : null;
      }),
    );
  }

  update(input: {
    ownerId: string;
    streamId: string;
    patch: UpdateStreamPatch;
  }): Promise<Stream | null> {
    return withDbInfra("stream update failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const existing = await client.query<StreamRow>(
          `SELECT id, owner_id, name, mode, rules_json, ai_prompt, version,
                  backfill_status, created_at, updated_at
           FROM streams
           WHERE id = $1
           FOR UPDATE`,
          [input.streamId],
        );
        const current = existing.rows[0];
        if (!current) return null;

        const nextName = input.patch.name ?? current.name;
        const nextMode = input.patch.mode ?? current.mode;
        const nextRules =
          input.patch.rulesJson !== undefined ? input.patch.rulesJson : current.rules_json;
        const nextPrompt =
          input.patch.aiPrompt !== undefined ? input.patch.aiPrompt : current.ai_prompt;

        const definitionChanged =
          nextMode !== current.mode ||
          !sameJson(nextRules, current.rules_json) ||
          nextPrompt !== current.ai_prompt;

        const nextVersion = definitionChanged ? current.version + 1 : current.version;
        const nextBackfill = definitionChanged ? "pending" : current.backfill_status;

        const { rows } = await client.query<StreamRow>(
          `UPDATE streams
           SET name = $2,
               mode = $3,
               rules_json = $4::jsonb,
               ai_prompt = $5,
               version = $6,
               backfill_status = $7,
               updated_at = now()
           WHERE id = $1
           RETURNING id, owner_id, name, mode, rules_json, ai_prompt, version,
                     backfill_status, created_at, updated_at`,
          [
            input.streamId,
            nextName,
            nextMode,
            JSON.stringify(nextRules),
            nextPrompt,
            nextVersion,
            nextBackfill,
          ],
        );
        const updated = mapRow(rows[0]!);

        if (definitionChanged) {
          await this.publishReclassify(client, {
            ownerId: input.ownerId,
            streamId: updated.id,
            version: updated.version,
          });
        }

        return updated;
      }),
    );
  }

  delete(ownerId: string, streamId: string): Promise<boolean> {
    return withDbInfra("stream delete failed", () =>
      withOwner(this.pool, ownerId, async (client) => {
        const result = await client.query(`DELETE FROM streams WHERE id = $1`, [streamId]);
        return (result.rowCount ?? 0) > 0;
      }),
    );
  }

  listMessages(input: ListStreamMessagesInput): Promise<ListStreamMessagesResult> {
    return withDbInfra("stream messages list failed", () =>
      withOwner(this.pool, input.ownerId, async (client) => {
        const exists = await client.query<{ id: string }>(`SELECT id FROM streams WHERE id = $1`, [
          input.streamId,
        ]);
        if (!exists.rows[0]) {
          return { messages: null };
        }

        type MembershipRow = {
          id: string;
          sender: string;
          body_ciphertext: Buffer;
          received_at: Date;
          device_id: string;
          sim_slot: number | null;
          direction: MessageDirection;
          matched_by: StreamMatchedBy;
          confidence: number | null;
          stream_version: number;
        };

        const params: unknown[] = [input.streamId, input.limit];
        let cursorClause = "";
        if (input.cursor) {
          params.push(input.cursor.receivedAt.toISOString(), input.cursor.id);
          cursorClause = `AND (m.received_at, m.id) < ($3::timestamptz, $4::uuid)`;
        }

        const { rows } = await client.query<MembershipRow>(
          `SELECT m.id, m.sender, m.body_ciphertext, m.received_at, m.device_id,
                  m.sim_slot, m.direction, sm.matched_by, sm.confidence, sm.stream_version
           FROM stream_membership sm
           INNER JOIN messages m ON m.id = sm.message_id
           WHERE sm.stream_id = $1
             ${cursorClause}
           ORDER BY m.received_at DESC, m.id DESC
           LIMIT $2`,
          params,
        );

        const messages: StreamMessageRecord[] = rows.map((row) => ({
          id: row.id,
          sender: row.sender,
          bodyCiphertext: new Uint8Array(row.body_ciphertext),
          receivedAt: row.received_at,
          deviceId: row.device_id,
          simSlot: row.sim_slot,
          direction: row.direction,
          matchedBy: row.matched_by,
          confidence: row.confidence,
          streamVersion: row.stream_version,
        }));

        return { messages };
      }),
    );
  }

  private async publishReclassify(
    client: PoolClient,
    opts: { ownerId: string; streamId: string; version: number },
  ): Promise<void> {
    try {
      await this.queue.publishInTx(
        client,
        {
          type: "stream.reclassify",
          owner_id: opts.ownerId,
          stream_id: opts.streamId,
          version: opts.version,
        },
        { singletonKey: `stream.reclassify:${opts.streamId}:v${opts.version}` },
      );
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "stream.reclassify publish failed");
    }
  }
}
