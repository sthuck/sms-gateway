import {
  normaliseDirection,
  normaliseReceivedAt,
  normaliseSender,
  normaliseSimSlot,
} from "./normalise.js";
import {
  MAX_BODY_CHARS,
  MAX_DEVICE_MSG_ID_LEN,
  type FormatPhoneSender,
  type ItemErrorCode,
  type ValidatedMessage,
} from "./types.js";

export type ItemValidation =
  | { ok: true; value: ValidatedMessage }
  | { ok: false; deviceMsgId: string; code: ItemErrorCode; detail: string };

/**
 * Validate and normalise one batch item. Does not touch the database.
 * Owner / device ids in the payload are ignored (never trusted).
 */
export function validateBatchItem(
  raw: unknown,
  defaultPhoneRegion: string,
  formatPhone: FormatPhoneSender,
  now: Date = new Date(),
): ItemValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      deviceMsgId: "",
      code: "invalid_field",
      detail: "message item must be an object",
    };
  }

  const item = raw as Record<string, unknown>;
  void item.owner_id;
  void item.ownerId;
  void item.device_id;
  void item.deviceId;

  const deviceMsgIdRaw = item.device_msg_id;
  let deviceMsgId = "";
  if (typeof deviceMsgIdRaw === "string") {
    deviceMsgId = deviceMsgIdRaw;
  }

  if (deviceMsgIdRaw === undefined || deviceMsgIdRaw === null || deviceMsgId === "") {
    return {
      ok: false,
      deviceMsgId: "",
      code: "missing_field",
      detail: "device_msg_id is required",
    };
  }
  if (typeof deviceMsgIdRaw !== "string") {
    return {
      ok: false,
      deviceMsgId: "",
      code: "invalid_field",
      detail: "device_msg_id must be a string",
    };
  }
  if (deviceMsgId.length > MAX_DEVICE_MSG_ID_LEN) {
    return {
      ok: false,
      deviceMsgId,
      code: "invalid_field",
      detail: "device_msg_id exceeds 128 characters",
    };
  }

  if (item.body === undefined || item.body === null) {
    return {
      ok: false,
      deviceMsgId,
      code: "missing_field",
      detail: "body is required",
    };
  }
  if (typeof item.body !== "string") {
    return {
      ok: false,
      deviceMsgId,
      code: "invalid_field",
      detail: "body must be a string",
    };
  }
  if ([...item.body].length > MAX_BODY_CHARS) {
    return {
      ok: false,
      deviceMsgId,
      code: "body_too_large",
      detail: `body exceeds ${MAX_BODY_CHARS} characters`,
    };
  }

  const sender = normaliseSender(item.sender, defaultPhoneRegion, formatPhone);
  if (!sender.ok) {
    return { ok: false, deviceMsgId, code: sender.code, detail: sender.detail };
  }

  const receivedAt = normaliseReceivedAt(item.received_at, now);
  if (!receivedAt.ok) {
    return { ok: false, deviceMsgId, code: receivedAt.code, detail: receivedAt.detail };
  }

  const simSlot = normaliseSimSlot(item.sim_slot);
  if (!simSlot.ok) {
    return { ok: false, deviceMsgId, code: simSlot.code, detail: simSlot.detail };
  }

  const direction = normaliseDirection(item.direction);
  if (!direction.ok) {
    return { ok: false, deviceMsgId, code: direction.code, detail: direction.detail };
  }

  return {
    ok: true,
    value: {
      deviceMsgId,
      sender: sender.sender,
      body: item.body,
      receivedAt: receivedAt.receivedAt,
      simSlot: simSlot.simSlot,
      direction: direction.direction,
    },
  };
}
