import { z } from "zod";
import {
  loadClientAccessConfig,
  type ClientAccessConfig,
} from "./adapters/access-headers/index.js";
import { loadOidcAuthConfig, type OidcAuthConfig } from "./adapters/auth-oidc/oidc-config.js";
import { loadDeviceAuthConfig, type DeviceAuthConfig } from "./adapters/device-crypto/config.js";
import { loadIngestConfig, type IngestConfig } from "./adapters/ingest/index.js";
import { loadEncryptionConfig, type EncryptionConfig } from "./adapters/key-wrapper/config.js";

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
  /** @deprecated Prefer KEK_FILE (STH-20). Kept so existing Helm secrets do not fail parse. */
  ENCRYPTION_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  /** Comma-separated browser origins allowed for CORS (and CSRF Origin checks). */
  CORS_ALLOWED_ORIGINS: z.string().optional().default(""),
  /**
   * Fastify trustProxy for request.ip (rate limits / audit).
   * - `false` (default) / empty: trust nothing
   * - `true`: trust every hop (unsafe; prefer CIDR; warns in production)
   * - digits: hop count (`0` = none, `1` = one hop)
   * - comma-separated proxy IPs/CIDRs: trust those peers only
   * Never parse X-Forwarded-For by hand.
   */
  TRUST_PROXY: z.string().optional().default("false"),
  /** Optional directory of built web UI assets (`web/dist`) served by the API. */
  WEB_DIST_DIR: z.string().optional().default(""),
});

export type TrustProxyOption = boolean | number | string | string[];

/** Fastify's typed trustProxy shape (types omit hop-count numbers). */
export type FastifyTrustProxy =
  boolean | string | string[] | ((address: string, hop: number) => boolean);

export type Config = Omit<
  z.infer<typeof envSchema>,
  "CORS_ALLOWED_ORIGINS" | "TRUST_PROXY" | "WEB_DIST_DIR"
> & {
  corsAllowedOrigins: string[];
  trustProxy: TrustProxyOption;
  webDistDir: string | null;
  oidc: OidcAuthConfig | null;
  deviceAuth: DeviceAuthConfig;
  ingest: IngestConfig;
  encryption: EncryptionConfig;
  clientAccess: ClientAccessConfig;
};

/** Loose IPv4 / IPv6 / CIDR check for TRUST_PROXY list entries. */
export function isProxyAddress(entry: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?$/.test(entry)) {
    const [ip] = entry.split("/");
    return ip!
      .split(".")
      .map(Number)
      .every((o) => o <= 255);
  }
  if (entry.includes(":")) {
    const [addr, prefix] = entry.split("/");
    if (prefix !== undefined && !/^(?:12[0-8]|1[01]\d|[1-9]?\d)$/.test(prefix)) {
      return false;
    }
    return /^[0-9a-fA-F:]+$/.test(addr!) && (addr!.match(/:/g)?.length ?? 0) >= 1;
  }
  return false;
}

/**
 * Parse TRUST_PROXY (STH-38/42).
 *
 * Only the words `true` / `false` are booleans. All-digit values are hop
 * counts (`0` = none, `1` = one hop) — never boolean. Anything else must be
 * an explicit proxy IP/CIDR list. Prefer CIDRs in production; `true` trusts
 * every hop and lets clients spoof X-Forwarded-For.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyOption {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "false") return false;
  if (trimmed === "true") return true;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return hops === 0 ? false : hops;
  }
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!isProxyAddress(part)) {
      throw new Error(
        `Invalid TRUST_PROXY entry "${part}": use false, true, a hop count, or IP/CIDR list`,
      );
    }
  }
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

  const {
    CORS_ALLOWED_ORIGINS: corsRaw,
    TRUST_PROXY: trustProxyRaw,
    WEB_DIST_DIR: webDistDirRaw,
    ...rest
  } = parsed.data;
  const webDistDir = webDistDirRaw.trim() || null;
  const corsAllowedOrigins = parseCorsAllowedOrigins(corsRaw);
  for (const origin of corsAllowedOrigins) {
    try {
      void new URL(origin);
    } catch {
      throw new Error(`Invalid configuration: CORS_ALLOWED_ORIGINS entry is not a URL: ${origin}`);
    }
  }

  let trustProxy: TrustProxyOption;
  try {
    trustProxy = parseTrustProxy(trustProxyRaw);
  } catch (err) {
    throw new Error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (trustProxy === true && rest.NODE_ENV === "production") {
    console.warn(
      "[config] TRUST_PROXY=true trusts every forwarded hop; prefer an explicit proxy IP/CIDR list",
    );
  }

  const oidc = loadOidcAuthConfig(env, { nodeEnv: rest.NODE_ENV });
  if (oidc && corsAllowedOrigins.length > 0) {
    oidc.corsAllowedOrigins = corsAllowedOrigins;
  }

  const deviceAuth = loadDeviceAuthConfig(env, {
    publicBaseUrl: oidc?.publicBaseUrl ?? null,
  });
  const ingest = loadIngestConfig(env);
  const encryption = loadEncryptionConfig(env, { nodeEnv: rest.NODE_ENV });
  const clientAccess = loadClientAccessConfig(env);

  return {
    ...rest,
    corsAllowedOrigins,
    trustProxy,
    webDistDir,
    oidc,
    deviceAuth,
    ingest,
    encryption,
    clientAccess,
  };
}
