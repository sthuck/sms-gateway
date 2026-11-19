export type MessageListParams = {
  device_id?: string;
  sender?: string;
  received_after?: string;
  received_before?: string;
  q?: string;
  cursor?: string;
  limit?: number;
};

export function messagesListPath(params: MessageListParams): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `/v1/messages?${qs}` : "/v1/messages";
}

/** Converts `datetime-local` input to ISO 8601 for the API. */
export function datetimeLocalToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}
