export const MAX_BATCH_MESSAGES = 100;
export const MAX_BODY_CHARS = 32_768;
export const MAX_DEVICE_MSG_ID_LEN = 128;
export const MAX_PAYLOAD_BYTES = 1_048_576;

export type MessageDirection = "inbound" | "outbound";

export type ItemErrorCode =
  "missing_field" | "invalid_field" | "body_too_large" | "duplicate_in_batch";

export type ValidatedMessage = {
  deviceMsgId: string;
  sender: string;
  body: string;
  receivedAt: Date;
  simSlot: number | null;
  direction: MessageDirection;
};

export type BatchItemResult =
  | { device_msg_id: string; status: "accepted"; id: string }
  | { device_msg_id: string; status: "duplicate"; id: string }
  | {
      device_msg_id: string;
      status: "rejected";
      error: { code: ItemErrorCode; detail: string };
    };

/**
 * Format a phone-like sender to E.164.
 * Return null when the value is not a possible phone number (caller keeps raw).
 */
export type FormatPhoneSender = (raw: string, defaultRegion: string) => string | null;
