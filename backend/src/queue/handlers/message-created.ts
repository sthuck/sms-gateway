import type { MessageCreatedEvent } from "../events.js";
import type { OwnerJobHandler } from "../register.js";

/**
 * Stub for the stream engine (STH-15 / STH-24). Logs IDs only.
 */
export const handleMessageCreated: OwnerJobHandler<MessageCreatedEvent> = async ({
  event,
  log,
}) => {
  log.info(
    {
      ownerId: event.owner_id,
      messageId: event.message_id,
      deviceId: event.device_id,
    },
    "stub handler message.created",
  );
};
