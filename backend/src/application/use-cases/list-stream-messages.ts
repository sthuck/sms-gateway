import { StreamError } from "../../domain/stream/errors.js";
import {
  decodeStreamMessageCursor,
  encodeStreamMessageCursor,
  type StreamMessageCursor,
} from "../../domain/stream/cursor.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type { StreamMatchedBy, StreamRepository } from "../../ports/outbound/stream-repository.js";
import type { MessageDirection } from "../../domain/message/types.js";

export const DEFAULT_STREAM_MESSAGES_LIMIT = 50;
export const MAX_STREAM_MESSAGES_LIMIT = 200;

export type ListStreamMessagesDeps = {
  streams: StreamRepository;
  bodyCodec: BodyCodec;
};

export type ListStreamMessagesInput = {
  ownerId: string;
  streamId: string;
  limit?: number;
  cursor?: string;
};

export type StreamMessageDto = {
  id: string;
  sender: string;
  body: string;
  receivedAt: Date;
  deviceId: string;
  simSlot: number | null;
  direction: MessageDirection;
  matchedBy: StreamMatchedBy;
  confidence: number | null;
  streamVersion: number;
};

export type ListStreamMessagesResult = {
  messages: StreamMessageDto[];
  nextCursor: string | null;
  limit: number;
};

export class ListStreamMessages {
  constructor(private readonly deps: ListStreamMessagesDeps) {}

  async execute(input: ListStreamMessagesInput): Promise<ListStreamMessagesResult> {
    const limit = input.limit ?? DEFAULT_STREAM_MESSAGES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STREAM_MESSAGES_LIMIT) {
      throw new StreamError(
        "invalid_request",
        400,
        `limit must be an integer between 1 and ${MAX_STREAM_MESSAGES_LIMIT}`,
        {
          errors: [
            {
              path: "limit",
              message: `must be an integer between 1 and ${MAX_STREAM_MESSAGES_LIMIT}`,
            },
          ],
        },
      );
    }

    let cursor: StreamMessageCursor | undefined;
    if (input.cursor !== undefined) {
      const parsed = decodeStreamMessageCursor(input.cursor);
      if (!parsed.ok) {
        throw new StreamError("invalid_request", 400, `cursor ${parsed.message}`, {
          errors: [{ path: "cursor", message: parsed.message }],
        });
      }
      cursor = parsed.value;
    }

    try {
      const listInput =
        cursor === undefined
          ? {
              ownerId: input.ownerId,
              streamId: input.streamId,
              limit: limit + 1,
            }
          : {
              ownerId: input.ownerId,
              streamId: input.streamId,
              limit: limit + 1,
              cursor,
            };

      const result = await this.deps.streams.listMessages(listInput);
      if (result.messages === null) {
        throw new StreamError("not_found", 404, "Stream not found");
      }

      const page = result.messages;
      const hasMore = page.length > limit;
      const slice = hasMore ? page.slice(0, limit) : page;
      const last = slice[slice.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeStreamMessageCursor({ receivedAt: last.receivedAt, id: last.id })
          : null;

      const messages: StreamMessageDto[] = slice.map((row) => ({
        id: row.id,
        sender: row.sender,
        body: this.deps.bodyCodec.decode(input.ownerId, row.bodyCiphertext),
        receivedAt: row.receivedAt,
        deviceId: row.deviceId,
        simSlot: row.simSlot,
        direction: row.direction,
        matchedBy: row.matchedBy,
        confidence: row.confidence,
        streamVersion: row.streamVersion,
      }));

      return { messages, nextCursor, limit };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof StreamError) throw err;
      throw InfrastructureError.wrap(err, "stream messages list failed");
    }
  }
}
