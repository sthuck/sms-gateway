import { z } from "zod";

const ingestEnvSchema = z.object({
  /** Default region for libphonenumber-js when sender lacks a country code. */
  INGEST_DEFAULT_PHONE_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  /** Max batch requests per device per window. Default 60. */
  INGEST_RATE_LIMIT_PER_DEVICE: z.coerce.number().int().positive().default(60),
  /** Window for per-device request limit, seconds. Default 60. */
  INGEST_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  /** Max messages ingested per device per hour. Default 10_000. */
  INGEST_MESSAGE_RATE_LIMIT: z.coerce.number().int().positive().default(10_000),
  /** Window for message volume limit, seconds. Default 3600. */
  INGEST_MESSAGE_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
});

export type IngestConfig = {
  defaultPhoneRegion: string;
  rateLimitPerDevice: number;
  rateLimitWindowSec: number;
  messageRateLimit: number;
  messageRateWindowSec: number;
};

export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  defaultPhoneRegion: "US",
  rateLimitPerDevice: 60,
  rateLimitWindowSec: 60,
  messageRateLimit: 10_000,
  messageRateWindowSec: 3600,
};

export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const parsed = ingestEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ingest configuration: ${details}`);
  }
  return {
    defaultPhoneRegion: parsed.data.INGEST_DEFAULT_PHONE_REGION,
    rateLimitPerDevice: parsed.data.INGEST_RATE_LIMIT_PER_DEVICE,
    rateLimitWindowSec: parsed.data.INGEST_RATE_LIMIT_WINDOW_SEC,
    messageRateLimit: parsed.data.INGEST_MESSAGE_RATE_LIMIT,
    messageRateWindowSec: parsed.data.INGEST_MESSAGE_RATE_WINDOW_SEC,
  };
}
