import type { MessageCursor } from "../../domain/message/cursor.js";
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
  deviceMsgId: string;
  sender: string;
  bodyCiphertext: Uint8Array;
  receivedAt: Date;
  simSlot: number | null;
  direction: MessageDirection;
};

/** Plaintext metadata filters applied in SQL before any decrypt. */
export type MessageListFilters = {
  deviceId?: string;
  sender?: string;
  receivedAfter?: Date;
  receivedBefore?: Date;
};

export type MessageListInput = {
  ownerId: string;
  limit: number;
  cursor?: MessageCursor;
  filters?: MessageListFilters;
};

/**
 * Idempotent message writes under RLS (`withOwner`).
 *
 * - Uniqueness: `(device_id, device_msg_id)`; duplicates are a no-op.
 * - Publishes `message.created` for NEW rows only (same transaction).
 * - Updates `devices.last_seen_at`.
 * - Infra failures MUST throw `InfrastructureError`.
 * - Lookups return `null` / empty for absence under RLS (never throw for miss).
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

  /**
   * Owner inbox keyset page: `received_at DESC, id DESC`.
   * Optional plaintext metadata filters narrow the candidate set (ADR 0002).
   */
  list(input: MessageListInput): Promise<MessageRecord[]>;

  /** Single message under RLS; `null` when missing / other owner. */
  findById(ownerId: string, messageId: string): Promise<MessageRecord | null>;

  /**
   * Delete under RLS. Returns false when no row matched (already gone or
   * other owner). Does not throw on zero rows.
   */
  delete(ownerId: string, messageId: string): Promise<boolean>;

  /**
   * Keyset page for DEK re-encrypt jobs, ordered by `id ASC`.
   */
  listCiphertextBatch(
    ownerId: string,
    opts: { limit: number; afterId?: string },
  ): Promise<MessageRecord[]>;

  /** Replace body_ciphertext in place (DEK rotation re-encrypt). */
  updateCiphertext(
    ownerId: string,
    messageId: string,
    bodyCiphertext: Uint8Array,
  ): Promise<boolean>;
};
