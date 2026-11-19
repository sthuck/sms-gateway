import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Paths whose values must never appear in logs (message bodies, pairing
 * codes, signatures). Redaction uses pino's path syntax.
 */
export const REDACT_PATHS = [
  "body",
  "text",
  "message",
  "messages",
  "messages[*].body",
  "req.body",
  "req.body.messages",
  "req.body.messages[*].body",
  "res.body",
  "pairing_code",
  "pairingCode",
  "public_key",
  "publicKey",
  "signature",
  "X-Signature",
  'headers["x-signature"]',
  "LLM_API_KEY",
  "apiKey",
  "ENCRYPTION_KEY",
  "KEK_FILE",
  "wrappedDek",
  "wrapped_dek",
  "bodyCiphertext",
  "body_ciphertext",
] as const;

export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      // Avoid dumping full request/response payloads via default serializers.
      req(req) {
        return {
          method: req.method as string | undefined,
          url: req.url as string | undefined,
          host: (req.headers as Record<string, string> | undefined)?.host,
          remoteAddress: req.remoteAddress as string | undefined,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode as number | undefined,
        };
      },
    },
  };
}

export function createLogger(level: string): Logger {
  return pino(buildLoggerOptions(level));
}
