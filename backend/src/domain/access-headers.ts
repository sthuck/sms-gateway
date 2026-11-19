export type AccessHeadersMap = Record<string, string>;

export const ACCESS_HEADER_MAX_COUNT = 8;
export const ACCESS_HEADER_MAX_JSON_BYTES = 2048;
export const ACCESS_HEADER_MAX_NAME_LEN = 128;
export const ACCESS_HEADER_MAX_VALUE_LEN = 1024;

export const RESERVED_ACCESS_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "origin",
  "referer",
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "x-csrf-token",
  "x-device-id",
  "x-timestamp",
  "x-nonce",
  "x-content-sha256",
  "x-signature",
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_RE = /^[\x20-\x7E]+$/;
const UNPADDED_B64URL_RE = /^[A-Za-z0-9_-]+$/;
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Validate an access-headers map against the shared wire contract.
 * Returns a fresh plain object copy with validated entries.
 */
export function validateAccessHeaders(input: unknown): AccessHeadersMap {
  if (!isPlainObject(input)) {
    throw new Error("Access headers must be a non-empty plain JSON object");
  }

  const entries = Object.entries(input);
  if (entries.length === 0) {
    throw new Error("Access headers must contain at least one header");
  }
  if (entries.length > ACCESS_HEADER_MAX_COUNT) {
    throw new Error(`Access headers must contain at most ${ACCESS_HEADER_MAX_COUNT} headers`);
  }

  const seenLower = new Set<string>();
  const normalized: AccessHeadersMap = {};

  for (const [name, value] of entries) {
    if (name.length < 1 || name.length > ACCESS_HEADER_MAX_NAME_LEN) {
      throw new Error(
        `Access header name "${name}" must be 1..${ACCESS_HEADER_MAX_NAME_LEN} characters`,
      );
    }
    if (!HEADER_NAME_RE.test(name)) {
      throw new Error(`Access header name "${name}" contains invalid token characters`);
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      throw new Error(`Duplicate access header name (case-insensitive): "${name}"`);
    }
    if (RESERVED_ACCESS_HEADER_NAMES.has(lower)) {
      throw new Error(`Access header name "${name}" is reserved and cannot be configured`);
    }
    seenLower.add(lower);

    if (typeof value !== "string") {
      throw new Error(`Access header "${name}" value must be a string`);
    }
    if (value.length < 1 || value.length > ACCESS_HEADER_MAX_VALUE_LEN) {
      throw new Error(
        `Access header "${name}" value must be 1..${ACCESS_HEADER_MAX_VALUE_LEN} characters`,
      );
    }
    if (!HEADER_VALUE_RE.test(value) || value.trim() !== value) {
      throw new Error(
        `Access header "${name}" value must be printable ASCII without leading/trailing whitespace`,
      );
    }

    Object.defineProperty(normalized, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const jsonBytes = utf8Encoder.encode(JSON.stringify(normalized));
  if (jsonBytes.byteLength > ACCESS_HEADER_MAX_JSON_BYTES) {
    throw new Error(
      `Access headers compact JSON exceeds ${ACCESS_HEADER_MAX_JSON_BYTES} UTF-8 bytes`,
    );
  }

  return normalized;
}

function encodeBase64UrlUnpadded(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1]! : 0;
    const b2 = hasB2 ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET[(triple >>> 18) & 0x3f]!;
    out += B64URL_ALPHABET[(triple >>> 12) & 0x3f]!;
    if (hasB1) {
      out += B64URL_ALPHABET[(triple >>> 6) & 0x3f]!;
    }
    if (hasB2) {
      out += B64URL_ALPHABET[triple & 0x3f]!;
    }
  }
  return out;
}

function decodeBase64UrlUnpadded(encoded: string): Uint8Array {
  if (encoded.length === 0 || !UNPADDED_B64URL_RE.test(encoded)) {
    throw new Error("Access headers parameter must be non-empty unpadded base64url");
  }
  const rem = encoded.length % 4;
  if (rem === 1) {
    throw new Error("Invalid unpadded base64url length");
  }

  const fullQuads = Math.floor(encoded.length / 4);
  const tailLen = rem === 0 ? 0 : rem === 2 ? 1 : 2;
  const out = new Uint8Array(fullQuads * 3 + tailLen);

  let inIdx = 0;
  let outIdx = 0;
  for (let q = 0; q < fullQuads; q += 1) {
    const c0 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c1 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c2 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c3 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outIdx++] = (triple >>> 16) & 0xff;
    out[outIdx++] = (triple >>> 8) & 0xff;
    out[outIdx++] = triple & 0xff;
  }

  if (rem === 2) {
    const c0 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c1 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    if ((c1 & 0x0f) !== 0) {
      throw new Error("Non-canonical trailing bits in base64url access headers");
    }
    out[outIdx++] = (c0 << 2) | (c1 >>> 4);
  } else if (rem === 3) {
    const c0 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c1 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    const c2 = B64URL_LOOKUP[encoded.charCodeAt(inIdx++)]!;
    if ((c2 & 0x03) !== 0) {
      throw new Error("Non-canonical trailing bits in base64url access headers");
    }
    out[outIdx++] = (c0 << 2) | (c1 >>> 4);
    out[outIdx++] = ((c1 & 0x0f) << 4) | (c2 >>> 2);
  }

  return out;
}

/**
 * Validate and encode access headers as unpadded base64url of compact UTF-8 JSON.
 */
export function encodeAccessHeadersParam(headers: AccessHeadersMap): string {
  const validated = validateAccessHeaders(headers);
  const jsonBytes = utf8Encoder.encode(JSON.stringify(validated));
  return encodeBase64UrlUnpadded(jsonBytes);
}

/**
 * Decode and validate an unpadded base64url `headers` URI parameter.
 */
export function decodeAccessHeadersParam(encoded: string): AccessHeadersMap {
  const bytes = decodeBase64UrlUnpadded(encoded);
  if (bytes.byteLength > ACCESS_HEADER_MAX_JSON_BYTES) {
    throw new Error(
      `Decoded access headers JSON exceeds ${ACCESS_HEADER_MAX_JSON_BYTES} UTF-8 bytes`,
    );
  }
  let jsonStr: string;
  try {
    jsonStr = utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Access headers parameter is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr) as unknown;
  } catch {
    throw new Error("Access headers parameter is not valid JSON");
  }
  return validateAccessHeaders(parsed);
}
