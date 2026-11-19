import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildLoggerOptions } from "../src/logger.js";

describe("logger redaction", () => {
  it("redacts message body fields", () => {
    const lines: string[] = [];
    const logger = pino(buildLoggerOptions("info"), {
      write(chunk: string) {
        lines.push(chunk);
      },
    });

    logger.info({ body: "Your code is 123456", sender: "+15551234567" }, "ingest");

    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!) as { body?: string; sender?: string };
    expect(parsed.body).toBe("[REDACTED]");
    expect(parsed.sender).toBe("+15551234567");
  });

  it("redacts Cloudflare Access secrets, access_headers, and qr_payload fields", () => {
    const lines: string[] = [];
    const logger = pino(buildLoggerOptions("info"), {
      write(chunk: string) {
        lines.push(chunk);
      },
    });

    logger.info(
      {
        CF_ACCESS_CLIENT_SECRET: "shared-sec",
        DEVICE_CF_ACCESS_CLIENT_SECRET: "dev-sec",
        AGENT_CF_ACCESS_CLIENT_SECRET: "agent-sec",
        "cf-access-client-secret": "hdr-sec",
        headers: {
          "cf-access-client-secret": "nested-hdr-sec",
          host: "sms.example",
        },
        req: {
          headers: {
            "cf-access-client-secret": "req-hdr-sec",
          },
        },
        access_headers: { "CF-Access-Client-Secret": "snake-sec" },
        accessHeaders: { "CF-Access-Client-Secret": "camel-sec" },
        qr_payload: "smsgw://pair?code=AAAA-BBBB&headers=secret",
        qrPayload: "smsgw://pair?code=AAAA-BBBB&headers=secret2",
        safe_id: "keep-me",
      },
      "cf access audit",
    );

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;
    expect(raw).not.toContain("shared-sec");
    expect(raw).not.toContain("dev-sec");
    expect(raw).not.toContain("agent-sec");
    expect(raw).not.toContain("hdr-sec");
    expect(raw).not.toContain("snake-sec");
    expect(raw).not.toContain("camel-sec");
    expect(raw).not.toContain("smsgw://pair");

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.CF_ACCESS_CLIENT_SECRET).toBe("[REDACTED]");
    expect(parsed.DEVICE_CF_ACCESS_CLIENT_SECRET).toBe("[REDACTED]");
    expect(parsed.AGENT_CF_ACCESS_CLIENT_SECRET).toBe("[REDACTED]");
    expect(parsed["cf-access-client-secret"]).toBe("[REDACTED]");
    expect((parsed.headers as Record<string, unknown>)["cf-access-client-secret"]).toBe(
      "[REDACTED]",
    );
    expect(parsed.access_headers).toBe("[REDACTED]");
    expect(parsed.accessHeaders).toBe("[REDACTED]");
    expect(parsed.qr_payload).toBe("[REDACTED]");
    expect(parsed.qrPayload).toBe("[REDACTED]");
    expect(parsed.safe_id).toBe("keep-me");
  });
});
