import type { FormatPhoneSender, MessageDirection } from "./types.js";

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
 */
export function normaliseSender(
  raw: unknown,
  defaultRegion: string,
  formatPhone: FormatPhoneSender,
): NormaliseSenderResult {
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

  if (!looksLikePhoneNumber(trimmed)) {
    return { ok: true, sender: trimmed };
  }

  const formatted = formatPhone(trimmed, defaultRegion);
  if (formatted) {
    return { ok: true, sender: formatted };
  }

  return { ok: true, sender: trimmed };
}

export function looksLikePhoneNumber(value: string): boolean {
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
  | { ok: true; direction: MessageDirection }
  | { ok: false; code: "missing_field" | "invalid_field"; detail: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, code: "missing_field", detail: "direction is required" };
  }
  if (raw !== "inbound" && raw !== "outbound") {
    return { ok: false, code: "invalid_field", detail: "direction must be inbound or outbound" };
  }
  return { ok: true, direction: raw };
}
