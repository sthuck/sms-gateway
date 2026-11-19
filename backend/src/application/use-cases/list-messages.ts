import {
  decodeMessageCursor,
  encodeMessageCursor,
  type MessageCursor,
} from "../../domain/message/cursor.js";
import { MessageError } from "../../domain/message/errors.js";
import type { MessageDirection } from "../../domain/message/types.js";
import {
  DecryptionError,
  InfrastructureError,
  isDecryptionError,
  isInfrastructureError,
} from "../../domain/errors.js";
import type { BodyCodec } from "../../ports/outbound/body-codec.js";
import type {
  MessageListFilters,
  MessageRecord,
  MessageRepository,
} from "../../ports/outbound/message-repository.js";

export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_MESSAGES_LIMIT = 200;
/** Max ciphertext rows decrypted per request when `q` is set (ADR 0002). */
export const MAX_MESSAGE_SEARCH_SCAN = 500;
export const MAX_MESSAGE_SEARCH_QUERY_LEN = 200;

export type ListMessagesDeps = {
  messages: MessageRepository;
  bodyCodec: BodyCodec;
};

export type ListMessagesInput = {
  ownerId: string;
  limit?: number;
  cursor?: string;
  deviceId?: string;
  sender?: string;
  receivedAfter?: string;
  receivedBefore?: string;
  /** Case-insensitive substring match on decrypted body (no blind index). */
  q?: string;
};

export type OwnerMessageDto = {
  id: string;
  sender: string;
  body: string;
  receivedAt: Date;
  deviceId: string;
  simSlot: number | null;
  direction: MessageDirection;
};

export type ListMessagesResult = {
  messages: OwnerMessageDto[];
  nextCursor: string | null;
  limit: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ListMessages {
  constructor(private readonly deps: ListMessagesDeps) {}

  async execute(input: ListMessagesInput): Promise<ListMessagesResult> {
    const limit = input.limit ?? DEFAULT_MESSAGES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES_LIMIT) {
      throw new MessageError(
        "invalid_request",
        400,
        `limit must be an integer between 1 and ${MAX_MESSAGES_LIMIT}`,
        {
          errors: [
            {
              path: "limit",
              message: `must be an integer between 1 and ${MAX_MESSAGES_LIMIT}`,
            },
          ],
        },
      );
    }

    let cursor: MessageCursor | undefined;
    if (input.cursor !== undefined) {
      const parsed = decodeMessageCursor(input.cursor);
      if (!parsed.ok) {
        throw new MessageError("invalid_request", 400, `cursor ${parsed.message}`, {
          errors: [{ path: "cursor", message: parsed.message }],
        });
      }
      cursor = parsed.value;
    }

    const filters = parseFilters(input);
    const q = input.q?.trim() ?? "";
    if (q.length > MAX_MESSAGE_SEARCH_QUERY_LEN) {
      throw new MessageError(
        "invalid_request",
        400,
        `q must be at most ${MAX_MESSAGE_SEARCH_QUERY_LEN} characters`,
        {
          errors: [
            {
              path: "q",
              message: `must be at most ${MAX_MESSAGE_SEARCH_QUERY_LEN} characters`,
            },
          ],
        },
      );
    }
    const hasText = q.length > 0;
    const qLower = hasText ? q.toLowerCase() : "";
    const fetchLimit = hasText ? MAX_MESSAGE_SEARCH_SCAN : limit + 1;

    try {
      const listInput: {
        ownerId: string;
        limit: number;
        cursor?: MessageCursor;
        filters?: MessageListFilters;
      } = {
        ownerId: input.ownerId,
        limit: fetchLimit,
      };
      if (filters) listInput.filters = filters;
      if (cursor) listInput.cursor = cursor;

      const rows = await this.deps.messages.list(listInput);
      const matched: OwnerMessageDto[] = [];

      for (const row of rows) {
        const body = await this.decodeRow(input.ownerId, row);
        if (hasText && !body.toLowerCase().includes(qLower)) {
          continue;
        }
        matched.push(toDto(row, body));
        if (matched.length > limit) {
          break;
        }
      }

      const page = matched.length > limit ? matched.slice(0, limit) : matched;
      const hitScanCap = hasText && rows.length === MAX_MESSAGE_SEARCH_SCAN;
      const hasMoreMatches = matched.length > limit;
      const hasMore = hasMoreMatches || hitScanCap;

      let nextCursor: string | null = null;
      if (hasMore) {
        if (page.length > 0 && (hasMoreMatches || !hitScanCap)) {
          const last = page[page.length - 1]!;
          nextCursor = encodeMessageCursor({ receivedAt: last.receivedAt, id: last.id });
        } else if (rows.length > 0) {
          const lastScanned = rows[rows.length - 1]!;
          nextCursor = encodeMessageCursor({
            receivedAt: lastScanned.receivedAt,
            id: lastScanned.id,
          });
        }
      }

      return { messages: page, nextCursor, limit };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (isDecryptionError(err) || err instanceof DecryptionError) throw err;
      if (err instanceof MessageError) throw err;
      throw InfrastructureError.wrap(err, "messages list failed");
    }
  }

  private decodeRow(ownerId: string, row: MessageRecord): Promise<string> {
    return this.deps.bodyCodec.decode(
      {
        ownerId,
        deviceId: row.deviceId,
        deviceMsgId: row.deviceMsgId,
      },
      row.bodyCiphertext,
    );
  }
}

function toDto(row: MessageRecord, body: string): OwnerMessageDto {
  return {
    id: row.id,
    sender: row.sender,
    body,
    receivedAt: row.receivedAt,
    deviceId: row.deviceId,
    simSlot: row.simSlot,
    direction: row.direction,
  };
}

function parseFilters(input: ListMessagesInput): MessageListFilters | undefined {
  const filters: MessageListFilters = {};

  if (input.deviceId !== undefined) {
    if (!UUID_RE.test(input.deviceId)) {
      throw new MessageError("invalid_request", 400, "device_id must be a UUID", {
        errors: [{ path: "device_id", message: "must be a UUID" }],
      });
    }
    filters.deviceId = input.deviceId;
  }

  if (input.sender !== undefined) {
    if (typeof input.sender !== "string" || input.sender.length === 0 || input.sender.length > 64) {
      throw new MessageError("invalid_request", 400, "sender must be 1..64 characters", {
        errors: [{ path: "sender", message: "must be 1..64 characters" }],
      });
    }
    filters.sender = input.sender;
  }

  if (input.receivedAfter !== undefined) {
    filters.receivedAfter = parseIso("received_after", input.receivedAfter);
  }
  if (input.receivedBefore !== undefined) {
    filters.receivedBefore = parseIso("received_before", input.receivedBefore);
  }

  if (
    filters.receivedAfter &&
    filters.receivedBefore &&
    filters.receivedAfter.getTime() > filters.receivedBefore.getTime()
  ) {
    throw new MessageError("invalid_request", 400, "received_after must be <= received_before", {
      errors: [{ path: "received_after", message: "must be <= received_before" }],
    });
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}

function parseIso(path: string, raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new MessageError("invalid_request", 400, `${path} must be an ISO-8601 date-time`, {
      errors: [{ path, message: "must be an ISO-8601 date-time" }],
    });
  }
  return d;
}
