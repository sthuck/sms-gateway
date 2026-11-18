export type CanonicalInputs = {
  method: string;
  path: string;
  query: string;
  host: string;
  deviceId: string;
  timestamp: string;
  contentSha256: string;
  nonce: string;
};

/** Nine fields joined by `\n`, no trailing newline after NONCE. */
export function buildCanonicalString(input: CanonicalInputs): string {
  return [
    "v1",
    input.method.toUpperCase(),
    input.path,
    input.query,
    input.host.toLowerCase(),
    input.deviceId,
    input.timestamp,
    input.contentSha256,
    input.nonce,
  ].join("\n");
}

export function isTimestampInWindow(
  timestampSec: number,
  nowSec: number,
  skewSec: number,
): boolean {
  return Math.abs(nowSec - timestampSec) <= skewSec;
}

/** Parse X-Timestamp: decimal Unix seconds, no leading zeros. */
export function parseTimestampHeader(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{8,11}$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
