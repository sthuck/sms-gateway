import { z } from "zod";

/**
 * Queue / worker settings live in this module (not `config.ts`) so OIDC work
 * on STH-9 can change app config without merge conflicts.
 */
const queueEnvSchema = z.object({
  /** Postgres schema holding pg-boss tables (not owner-scoped). */
  QUEUE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i, "QUEUE_SCHEMA must be a simple SQL identifier")
    .default("pgboss"),
  /** How many times a job may be retried before dead-lettering. */
  QUEUE_RETRY_LIMIT: z.coerce.number().int().min(0).max(50).default(5),
  /** Base retry delay in seconds (exponential when backoff is on). */
  QUEUE_RETRY_DELAY_SECONDS: z.coerce.number().int().min(0).max(3600).default(1),
  QUEUE_RETRY_BACKOFF: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  QUEUE_RETRY_DELAY_MAX_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  /** Worker poll interval in seconds (pg-boss minimum is 0.5). */
  QUEUE_POLLING_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(1),
  /** Local concurrency per queue inside one worker process. */
  QUEUE_LOCAL_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(1),
  /** Graceful shutdown wait for in-flight jobs (ms). */
  QUEUE_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(25_000),
  /** Optional Prometheus text metrics HTTP port on the worker (0 = disabled). */
  QUEUE_METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9090),
  QUEUE_METRICS_HOST: z.string().default("0.0.0.0"),
});

export type QueueConfig = z.infer<typeof queueEnvSchema>;

export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const parsed = queueEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid queue configuration: ${details}`);
  }
  return parsed.data;
}
