import { parsePhoneNumberFromString } from "libphonenumber-js";

const RECEIVED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export type NormaliseSenderResult =
  | { ok: true; sender: string }
  | { ok: false; code: "missing_field" | "invalid_field"; detail: string };

export type NormaliseTimestampResult =
  | { ok: true; receivedAt: Date }
  | { ok: false; code: "missing_field" | "invalid_field"; detail: string };

/**
 * Normalise sender to E.164 when it looks like a phone number.
 * Alphanumeric sender IDs (short codes / brand names) are kept as-is.
 * Never strips a leading `+` from an already-E.164 value that parses.
 */
export function normaliseSender(raw: unknown, defaultRegion: string): NormaliseSenderResult {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "missing_field", detail: "sender is required" };
  }
  if (typeof raw !== "string") {
    return { ok: false, code: "invalid_field", detail: "sender must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "missing_field", detail: "sender is required" };
  }
  if (trimmed.length > 64) {
    return { ok: false, code: "invalid_field", detail: "sender exceeds 64 characters" };
  }

  // Keep raw alphanumeric / short-code senders unchanged.
  if (!looksLikePhoneNumber(trimmed)) {
    return { ok: true, sender: trimmed };
  }

  const parsed = parsePhoneNumberFromString(
    trimmed,
    defaultRegion as Parameters<typeof parsePhoneNumberFromString>[1],
  );
  // Prefer isPossible over isValid so fictional/test numbers (e.g. +1555…)
  // still normalise to E.164 when the shape is a phone number.
  if (parsed && parsed.isPossible()) {
    return { ok: true, sender: parsed.format("E.164") };
  }

  // Digits that fail to parse stay as the client sent them (no silent rewrite).
  return { ok: true, sender: trimmed };
}

function looksLikePhoneNumber(value: string): boolean {
  // Has a digit and is not a pure alpha / alphanumeric brand token without +.
  if (value.startsWith("+")) return true;
  const digits = value.replace(/[\s().-]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  return digits.length >= 7;
}

/**
 * Parse `received_at` as ISO 8601 UTC with a `Z` suffix (optional fractional
 * seconds up to microseconds). Reject values more than 24 hours in the future.
 */
export function normaliseReceivedAt(
  raw: unknown,
  now: Date = new Date(),
): NormaliseTimestampResult {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "missing_field", detail: "received_at is required" };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "missing_field", detail: "received_at is required" };
  }
  if (!RECEIVED_AT_RE.test(raw)) {
    return {
      ok: false,
      code: "invalid_field",
      detail: "received_at must be ISO 8601 UTC with a Z suffix",
    };
  }

  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return { ok: false, code: "invalid_field", detail: "received_at is not a valid timestamp" };
  }

  if (ms - now.getTime() > MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      code: "invalid_field",
      detail: "received_at is more than 24 hours in the future",
    };
  }

  return { ok: true, receivedAt: new Date(ms) };
}

export function normaliseSimSlot(
  raw: unknown,
): { ok: true; simSlot: number | null } | { ok: false; code: "invalid_field"; detail: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, simSlot: null };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false, code: "invalid_field", detail: "sim_slot must be an integer or null" };
  }
  if (raw < 0 || raw > 9) {
    return { ok: false, code: "invalid_field", detail: "sim_slot must be between 0 and 9" };
  }
  return { ok: true, simSlot: raw };
}

export function normaliseDirection(
  raw: unknown,
):
  | { ok: true; direction: "inbound" | "outbound" }
  | { ok: false; code: "missing_field" | "invalid_field"; detail: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, code: "missing_field", detail: "direction is required" };
  }
  if (raw !== "inbound" && raw !== "outbound") {
    return { ok: false, code: "invalid_field", detail: "direction must be inbound or outbound" };
  }
  return { ok: true, direction: raw };
}
