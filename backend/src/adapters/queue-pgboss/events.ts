import { z } from "zod";

const uuid = z.string().uuid();

/**
 * Keys that must never appear on a queue payload. Message bodies, ciphertext,
 * and senders stay in Postgres; jobs carry IDs only.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  "body",
  "body_ciphertext",
  "ciphertext",
  "sender",
  "text",
  "message",
  "messages",
  "content",
  "plaintext",
] as const;

export const EVENT_NAMES = ["message.created", "stream.reclassify"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const MessageCreatedEventSchema = z
  .object({
    type: z.literal("message.created"),
    owner_id: uuid,
    message_id: uuid,
    device_id: uuid,
  })
  .strict();

export const StreamReclassifyEventSchema = z
  .object({
    type: z.literal("stream.reclassify"),
    owner_id: uuid,
    stream_id: uuid,
    version: z.number().int().positive(),
  })
  .strict();

export const QueueEventSchema = z.discriminatedUnion("type", [
  MessageCreatedEventSchema,
  StreamReclassifyEventSchema,
]);

export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;
export type StreamReclassifyEvent = z.infer<typeof StreamReclassifyEventSchema>;
export type QueueEvent = z.infer<typeof QueueEventSchema>;

export function deadLetterQueueName(eventName: EventName): string {
  return `${eventName}.dlq`;
}

function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Queue payload must not include "${key}" at ${path}.${key} (IDs only; no message bodies)`,
      );
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

/**
 * Validate and narrow a queue payload. Rejects unknown keys (`.strict()`) and
 * any nested forbidden body/sender fields.
 */
export function parseQueueEvent(input: unknown): QueueEvent {
  assertNoForbiddenKeys(input, "$");
  return QueueEventSchema.parse(input);
}

export function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}
