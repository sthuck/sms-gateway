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
});
