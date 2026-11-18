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

/** Fastify's typed trustProxy shape (types omit hop-count numbers). */
export type FastifyTrustProxy =
  boolean | string | string[] | ((address: string, hop: number) => boolean);

export type Config = Omit<z.infer<typeof envSchema>, "CORS_ALLOWED_ORIGINS" | "TRUST_PROXY"> & {
  corsAllowedOrigins: string[];
  trustProxy: TrustProxyOption;
  oidc: OidcAuthConfig | null;
  deviceAuth: DeviceAuthConfig;
};

/**
 * Parse TRUST_PROXY. Default / false / no → trust nothing.
 * All-digit values are hop counts (`0` = no proxy, `1` = one hop) — never
 * boolean, so `TRUST_PROXY=1` does not become `true` (STH-42).
 * Prefer an explicit proxy IP/CIDR list in production.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyOption {
  if (!raw || raw === "false" || raw === "no") return false;
  // Digits before boolean keywords so "1" / "0" are hop counts, not true/false.
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops === 0 ? false : hops;
  }
  if (raw === "true" || raw === "yes") return true;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return parts[0]!;
  return parts;
}

/**
 * Map our TrustProxyOption onto Fastify's typed trustProxy.
 * Hop counts become `(address, hop) => hop < n` (same as proxy-addr).
 */
export function toFastifyTrustProxy(opt: TrustProxyOption): FastifyTrustProxy {
  if (typeof opt === "number") {
    const hops = opt;
    return (_address, hop) => hop < hops;
  }
  return opt;
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
