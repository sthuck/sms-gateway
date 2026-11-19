import type { MessageDirection } from "../../domain/message/types.js";
import type { Stream, StreamMode, StreamRule } from "../../domain/stream/types.js";
import type { StreamMessageCursor } from "../../domain/stream/cursor.js";

export type InsertStreamInput = {
  ownerId: string;
  name: string;
  mode: StreamMode;
  rulesJson: StreamRule[];
  aiPrompt: string | null;
};

export type UpdateStreamPatch = {
  name?: string;
  mode?: StreamMode;
  rulesJson?: StreamRule[];
  aiPrompt?: string | null;
};

export type StreamMatchedBy = "rule" | "ai";

export type StreamMessageRecord = {
  id: string;
  sender: string;
  bodyCiphertext: Uint8Array;
  receivedAt: Date;
  deviceId: string;
  deviceMsgId: string;
  simSlot: number | null;
  direction: MessageDirection;
  matchedBy: StreamMatchedBy;
  confidence: number | null;
  streamVersion: number;
};

export type ListStreamMessagesInput = {
  ownerId: string;
  streamId: string;
  limit: number;
  cursor?: StreamMessageCursor;
};

export type ListStreamMessagesResult = {
  /** `null` when the stream is absent under RLS (caller maps to 404). */
  messages: StreamMessageRecord[] | null;
};

/**
 * Owner-scoped stream persistence under RLS (`withOwner`).
 *
 * - `null` / `false` = domain absence only.
 * - Definition-changing updates bump `version`, reset `backfill_status` to
 *   `pending`, and publish `stream.reclassify` in the same transaction.
 * - Infra failures MUST throw `InfrastructureError`.
 */
export type StreamRepository = {
  insert(input: InsertStreamInput): Promise<Stream>;
  list(ownerId: string, limit: number): Promise<Stream[]>;
  findById(ownerId: string, streamId: string): Promise<Stream | null>;
  update(input: {
    ownerId: string;
    streamId: string;
    patch: UpdateStreamPatch;
  }): Promise<Stream | null>;
  delete(ownerId: string, streamId: string): Promise<boolean>;
  /**
   * Messages belonging to the stream via `stream_membership`, ordered by
   * `messages.received_at DESC, messages.id DESC`. Returns `messages: null`
   * when the stream is not visible to the owner.
   */
  listMessages(input: ListStreamMessagesInput): Promise<ListStreamMessagesResult>;
};
