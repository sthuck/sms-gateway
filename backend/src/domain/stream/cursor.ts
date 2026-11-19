/**
 * Opaque cursor for stream message listing.
 * Encodes (received_at, id) for stable order: received_at DESC, id DESC.
 */

export type StreamMessageCursor = {
  receivedAt: Date;
  id: string;
};

export type CursorParseResult =
  { ok: true; value: StreamMessageCursor } | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeStreamMessageCursor(cursor: StreamMessageCursor): string {
  const payload = `${cursor.receivedAt.toISOString()}_${cursor.id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeStreamMessageCursor(raw: string): CursorParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, message: "must be a non-empty string" };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, message: "is not a valid cursor" };
  }
  const sep = decoded.lastIndexOf("_");
  if (sep <= 0) {
    return { ok: false, message: "is not a valid cursor" };
  }
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_RE.test(id)) {
    return { ok: false, message: "is not a valid cursor" };
  }
  const receivedAt = new Date(iso);
  if (Number.isNaN(receivedAt.getTime()) || !iso.endsWith("Z")) {
    return { ok: false, message: "is not a valid cursor" };
  }
  return { ok: true, value: { receivedAt, id } };
}
