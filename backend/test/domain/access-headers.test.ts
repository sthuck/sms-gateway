import { describe, expect, it } from "vitest";
import {
  ACCESS_HEADER_MAX_COUNT,
  ACCESS_HEADER_MAX_JSON_BYTES,
  ACCESS_HEADER_MAX_NAME_LEN,
  ACCESS_HEADER_MAX_VALUE_LEN,
  RESERVED_ACCESS_HEADER_NAMES,
  decodeAccessHeadersParam,
  encodeAccessHeadersParam,
  validateAccessHeaders,
} from "../../src/domain/access-headers.js";
import { formatPairingQrPayload } from "../../src/domain/device/pairing.js";

describe("access-headers domain", () => {
  it("validates and round-trips CF Access headers via unpadded base64url", () => {
    const headers = {
      "CF-Access-Client-Id": "client-id-123.access",
      "CF-Access-Client-Secret": "super-secret-token-value",
    };

    const validated = validateAccessHeaders(headers);
    expect(validated).toEqual(headers);
    expect(validated).not.toBe(headers);

    const encoded = encodeAccessHeadersParam(headers);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");

    const expectedBase64url = Buffer.from(JSON.stringify(headers), "utf8").toString("base64url");
    expect(encoded).toBe(expectedBase64url);
    expect(decodeAccessHeadersParam(encoded)).toEqual(headers);
  });

  it("round-trips base64url across byte lengths mod 3 == 0, 1, 2", () => {
    for (const suffixLen of [1, 2, 3, 4, 5, 6]) {
      const headers = { "X-Custom": "a".repeat(suffixLen) };
      const encoded = encodeAccessHeadersParam(headers);
      expect(encoded).toBe(Buffer.from(JSON.stringify(headers), "utf8").toString("base64url"));
      expect(decodeAccessHeadersParam(encoded)).toEqual(headers);
    }
  });

  it("rejects non-plain-object, empty, and non-string values", () => {
    expect(() => validateAccessHeaders(null)).toThrow();
    expect(() => validateAccessHeaders("string")).toThrow();
    expect(() => validateAccessHeaders(123)).toThrow();
    expect(() => validateAccessHeaders([])).toThrow();
    expect(() => validateAccessHeaders({})).toThrow();
    expect(() => validateAccessHeaders({ "X-A": 123 })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": true })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": null })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": { nested: "v" } })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": ["v"] })).toThrow();
  });

  it("enforces max header count (8)", () => {
    const ok: Record<string, string> = {};
    for (let i = 0; i < ACCESS_HEADER_MAX_COUNT; i += 1) {
      ok[`X-Header-${i}`] = `val-${i}`;
    }
    expect(Object.keys(validateAccessHeaders(ok))).toHaveLength(ACCESS_HEADER_MAX_COUNT);

    const tooMany = { ...ok, "X-Header-Extra": "val-extra" };
    expect(() => validateAccessHeaders(tooMany)).toThrow(/at most 8/);
  });

  it("enforces max JSON UTF-8 byte length (2048 bytes)", () => {
    const atLimitValueLen =
      ACCESS_HEADER_MAX_JSON_BYTES - Buffer.byteLength('{"X-Big":""}', "utf8");
    // Construct 2 headers since single header value max is 1024.
    const twoHeaders = {
      "X-One": "a".repeat(1000),
      "X-Two": "b".repeat(1000),
    };
    const jsonBytes = Buffer.byteLength(JSON.stringify(twoHeaders), "utf8");
    expect(jsonBytes).toBeLessThanOrEqual(ACCESS_HEADER_MAX_JSON_BYTES);
    expect(atLimitValueLen).toBeGreaterThan(ACCESS_HEADER_MAX_VALUE_LEN);
    expect(validateAccessHeaders(twoHeaders)).toEqual(twoHeaders);

    const overLimit = {
      "X-One": "a".repeat(1024),
      "X-Two": "b".repeat(1024),
    };
    expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBeGreaterThan(
      ACCESS_HEADER_MAX_JSON_BYTES,
    );
    expect(() => validateAccessHeaders(overLimit)).toThrow(/2048/);
  });

  it("validates header name length, RFC 7230 token chars, and case-insensitive duplicates", () => {
    expect(() => validateAccessHeaders({ "": "val" })).toThrow();
    expect(() =>
      validateAccessHeaders({ ["X".repeat(ACCESS_HEADER_MAX_NAME_LEN)]: "val" }),
    ).not.toThrow();
    expect(() =>
      validateAccessHeaders({ ["X".repeat(ACCESS_HEADER_MAX_NAME_LEN + 1)]: "val" }),
    ).toThrow();
    expect(() => validateAccessHeaders({ "Bad Header": "val" })).toThrow();
    expect(() => validateAccessHeaders({ "Bad:Header": "val" })).toThrow();
    expect(() => validateAccessHeaders({ "Bad\nHeader": "val" })).toThrow();
    expect(() => validateAccessHeaders({ "X-Test": "1", "x-test": "2" })).toThrow(/Duplicate/);
  });

  it("rejects all 17 reserved header names case-insensitively", () => {
    expect(RESERVED_ACCESS_HEADER_NAMES.size).toBe(17);
    for (const reserved of RESERVED_ACCESS_HEADER_NAMES) {
      expect(() => validateAccessHeaders({ [reserved]: "val" })).toThrow(/reserved/);
      expect(() => validateAccessHeaders({ [reserved.toUpperCase()]: "val" })).toThrow(/reserved/);
    }
  });

  it("validates header value length, printable ASCII, no control chars or outer whitespace", () => {
    expect(() => validateAccessHeaders({ "X-A": "" })).toThrow();
    expect(() =>
      validateAccessHeaders({ "X-A": "x".repeat(ACCESS_HEADER_MAX_VALUE_LEN) }),
    ).not.toThrow();
    expect(() =>
      validateAccessHeaders({ "X-A": "x".repeat(ACCESS_HEADER_MAX_VALUE_LEN + 1) }),
    ).toThrow();
    expect(() => validateAccessHeaders({ "X-A": " leading" })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "trailing " })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "has\rreturn" })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "has\nnewline" })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "has\u0000nul" })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "has\tdel\x7F" })).toThrow();
    expect(() => validateAccessHeaders({ "X-A": "non-ascii-é" })).toThrow();
    expect(validateAccessHeaders({ "X-A": "inner spaces allowed" })).toEqual({
      "X-A": "inner spaces allowed",
    });
  });

  it("rejects invalid base64url and invalid payloads on decode", () => {
    expect(() => decodeAccessHeadersParam("")).toThrow();
    expect(() => decodeAccessHeadersParam("e30=")).toThrow(); // padded
    expect(() => decodeAccessHeadersParam("ab+cd/ef")).toThrow(); // non-url b64
    expect(() => decodeAccessHeadersParam("abcde")).toThrow(); // length % 4 === 1
    expect(() =>
      decodeAccessHeadersParam(Buffer.from("{}", "utf8").toString("base64url")),
    ).toThrow();
    expect(() =>
      decodeAccessHeadersParam(Buffer.from('{"host":"evil"}', "utf8").toString("base64url")),
    ).toThrow();
    expect(() =>
      decodeAccessHeadersParam(Buffer.from("not-json", "utf8").toString("base64url")),
    ).toThrow();
  });

  it("formats pairing QR payload with and without access headers", () => {
    expect(formatPairingQrPayload("7K3M-9Q2P", "https://sms.example")).toBe(
      "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.example",
    );
    expect(formatPairingQrPayload("7K3M-9Q2P", "https://sms.example", null)).toBe(
      "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.example",
    );
    expect(formatPairingQrPayload("7K3M-9Q2P", "https://sms.example", {})).toBe(
      "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.example",
    );

    const headers = {
      "CF-Access-Client-Id": "id-1",
      "CF-Access-Client-Secret": "sec-1",
    };
    const uri = formatPairingQrPayload("7K3M-9Q2P", "https://sms.example", headers);
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("smsgw:");
    expect(parsed.hostname).toBe("pair");
    expect(parsed.searchParams.get("code")).toBe("7K3M-9Q2P");
    expect(parsed.searchParams.get("server")).toBe("https://sms.example");
    const headersParam = parsed.searchParams.get("headers")!;
    expect(headersParam).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAccessHeadersParam(headersParam)).toEqual(headers);
  });
});
