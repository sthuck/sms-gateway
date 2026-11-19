import type { MessageDirection } from "../../domain/message/types.js";

export type MessageInsert = {
  deviceMsgId: string;
  sender: string;
  bodyCiphertext: Uint8Array;
  receivedAt: Date;
  simSlot: number | null;
  direction: MessageDirection;
};

export type MessageUpsertRow =
  | { deviceMsgId: string; status: "accepted"; id: string }
  | { deviceMsgId: string; status: "duplicate"; id: string };

/** Owner-scoped message row for preview / listing (body still ciphertext). */
export type MessageRecord = {
  id: string;
  ownerId: string;
  deviceId: string;
  sender: string;
  bodyCiphertext: Uint8Array;
  receivedAt: Date;
  simSlot: number | null;
  direction: MessageDirection;
};

/**
 * Idempotent message writes under RLS (`withOwner`).
 *
 * - Uniqueness: `(device_id, device_msg_id)`; duplicates are a no-op.
 * - Publishes `message.created` for NEW rows only (same transaction).
 * - Updates `devices.last_seen_at`.
 * - Infra failures MUST throw `InfrastructureError`.
 */
export type MessageRepository = {
  upsertBatch(input: {
    ownerId: string;
    deviceId: string;
    messages: MessageInsert[];
  }): Promise<MessageUpsertRow[]>;

  /**
   * Most recent messages for the owner, ordered by `received_at DESC, id DESC`.
   * Used by stream preview (last N).
   */
  listRecent(ownerId: string, limit: number): Promise<MessageRecord[]>;
};
