import { z } from "zod";
import { loadOidcAuthConfig, type OidcAuthConfig } from "./auth/oidc-config.js";
import { loadDeviceAuthConfig, type DeviceAuthConfig } from "./device/config.js";

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
  /** Comma-separated browser origins allowed for CORS (and CSRF Origin checks). */
  CORS_ALLOWED_ORIGINS: z.string().optional().default(""),
  /**
   * Fastify trustProxy: `false` (default), `true`, hop count, or comma-separated
   * proxy IPs/CIDRs. When set, `request.ip` reflects the client behind those
   * proxies. Never parse X-Forwarded-For by hand.
   */
  TRUST_PROXY: z.string().optional().default("false"),
});

export type TrustProxyOption = boolean | number | string | string[];

export type Config = Omit<z.infer<typeof envSchema>, "CORS_ALLOWED_ORIGINS" | "TRUST_PROXY"> & {
  corsAllowedOrigins: string[];
  trustProxy: TrustProxyOption;
  oidc: OidcAuthConfig | null;
  deviceAuth: DeviceAuthConfig;
};

export function parseTrustProxy(raw: string | undefined): TrustProxyOption {
  if (!raw || raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return parts[0]!;
  return parts;
}

export function parseCorsAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const { CORS_ALLOWED_ORIGINS: corsRaw, TRUST_PROXY: trustProxyRaw, ...rest } = parsed.data;
  const corsAllowedOrigins = parseCorsAllowedOrigins(corsRaw);
  for (const origin of corsAllowedOrigins) {
    try {
      // Validate each entry is an absolute origin URL.
      void new URL(origin);
    } catch {
      throw new Error(`Invalid configuration: CORS_ALLOWED_ORIGINS entry is not a URL: ${origin}`);
    }
  }

  const oidc = loadOidcAuthConfig(env, { nodeEnv: rest.NODE_ENV });
  if (oidc && corsAllowedOrigins.length > 0) {
    oidc.corsAllowedOrigins = corsAllowedOrigins;
  }

  const deviceAuth = loadDeviceAuthConfig(env, {
    publicBaseUrl: oidc?.publicBaseUrl ?? null,
  });

  return {
    ...rest,
    corsAllowedOrigins,
    trustProxy: parseTrustProxy(trustProxyRaw),
    oidc,
    deviceAuth,
  };
}
