import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { FormatPhoneSender } from "../../domain/message/types.js";

/**
 * Prefer `isPossible` over `isValid` so fictional/test numbers (e.g. +1555…)
 * still normalise to E.164 when the shape is a phone number.
 */
export const formatPhoneSender: FormatPhoneSender = (raw, defaultRegion) => {
  const parsed = parsePhoneNumberFromString(
    raw,
    defaultRegion as Parameters<typeof parsePhoneNumberFromString>[1],
  );
  if (parsed && parsed.isPossible()) {
    return parsed.format("E.164");
  }
  return null;
};
