import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Application DB URL (role: sms_app, no BYPASSRLS). */
  DATABASE_URL: z.string().min(1).optional(),
  /** Privileged migrator URL (role: sms / owner). Used only by migrate scripts. */
  MIGRATE_DATABASE_URL: z.string().min(1).optional(),
  /**
   * Required by migrate:up. Applied only when role sms_app is first created.
   * Later migrations never reset it; rotate with a manual ALTER ROLE.
   */
  SMS_APP_PASSWORD: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}
