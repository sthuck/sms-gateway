import type { StreamReclassifyEvent } from "../events.js";
import type { OwnerJobHandler } from "../register.js";

/**
 * Stub for stream backfill / reclassify (STH-24). Logs IDs only.
 */
export const handleStreamReclassify: OwnerJobHandler<StreamReclassifyEvent> = async ({
  event,
  log,
}) => {
  log.info(
    {
      ownerId: event.owner_id,
      streamId: event.stream_id,
      version: event.version,
    },
    "stub handler stream.reclassify",
  );
};
