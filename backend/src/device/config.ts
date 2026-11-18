import { z } from "zod";
import { DEFAULT_RATE_LIMIT_CONFIG, type RateLimitConfig } from "./rate-limit.js";
import { PAIRING_CODE_TTL_SECONDS } from "./pairing-code.js";
import { CLOCK_SKEW_SECONDS, REPLAY_TTL_SECONDS } from "./signing.js";

const boolFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return v === "true" || v === "1" || v === "yes";
  });

const deviceEnvSchema = z.object({
  /**
   * Comma-separated Host values accepted in the signed canonical string.
   * Include port when clients send one (e.g. `10.0.2.2:8080`).
   */
  DEVICE_ALLOWED_HOSTS: z.string().optional().default(""),
  /** Base URL embedded as optional `server=` in pairing QR payloads. */
  DEVICE_API_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(PAIRING_CODE_TTL_SECONDS),
  DEVICE_CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(CLOCK_SKEW_SECONDS),
  DEVICE_REPLAY_TTL_SECONDS: z.coerce.number().int().positive().default(REPLAY_TTL_SECONDS),
  PAIR_RATE_LIMIT_PER_IP: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairPerIpLimit),
  PAIR_RATE_LIMIT_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairPerIpWindowSec),
  PAIR_GLOBAL_INVALID_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairGlobalInvalidLimit),
  PAIR_GLOBAL_INVALID_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairGlobalInvalidWindowSec),
  PAIR_IP_INVALID_LOCK_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairIpInvalidLockThreshold),
  PAIR_IP_INVALID_LOCK_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RATE_LIMIT_CONFIG.pairIpInvalidLockSec),
  /** When true, also accept Host from PUBLIC_BASE_URL / DEVICE_API_PUBLIC_URL. */
  DEVICE_ALLOW_DERIVED_HOSTS: boolFromEnv.default(true),
});

export type DeviceAuthConfig = {
  allowedHosts: Set<string>;
  apiPublicUrl: string | null;
  pairingCodeTtlSeconds: number;
  clockSkewSeconds: number;
  replayTtlSeconds: number;
  rateLimit: RateLimitConfig;
};

const LOCAL_DEFAULT_HOSTS = [
  "127.0.0.1:8080",
  "localhost:8080",
  "10.0.2.2:8080",
  "10.0.2.2:4010",
  "api.sms-gateway.example",
];

function hostFromUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

export function loadDeviceAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  extras?: { publicBaseUrl?: string | null },
): DeviceAuthConfig {
  const parsed = deviceEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid device auth configuration: ${details}`);
  }

  const data = parsed.data;
  const hosts = new Set<string>(
    data.DEVICE_ALLOWED_HOSTS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  if (hosts.size === 0) {
    for (const h of LOCAL_DEFAULT_HOSTS) hosts.add(h);
  }

  if (data.DEVICE_ALLOW_DERIVED_HOSTS) {
    const fromDevice = hostFromUrl(data.DEVICE_API_PUBLIC_URL || null);
    const fromPublic = hostFromUrl(extras?.publicBaseUrl ?? null);
    if (fromDevice) hosts.add(fromDevice);
    if (fromPublic) hosts.add(fromPublic);
  }

  return {
    allowedHosts: hosts,
    apiPublicUrl: data.DEVICE_API_PUBLIC_URL || extras?.publicBaseUrl || null,
    pairingCodeTtlSeconds: data.PAIRING_CODE_TTL_SECONDS,
    clockSkewSeconds: data.DEVICE_CLOCK_SKEW_SECONDS,
    replayTtlSeconds: data.DEVICE_REPLAY_TTL_SECONDS,
    rateLimit: {
      pairPerIpLimit: data.PAIR_RATE_LIMIT_PER_IP,
      pairPerIpWindowSec: data.PAIR_RATE_LIMIT_WINDOW_SEC,
      pairGlobalInvalidLimit: data.PAIR_GLOBAL_INVALID_LIMIT,
      pairGlobalInvalidWindowSec: data.PAIR_GLOBAL_INVALID_WINDOW_SEC,
      pairIpInvalidLockThreshold: data.PAIR_IP_INVALID_LOCK_THRESHOLD,
      pairIpInvalidLockSec: data.PAIR_IP_INVALID_LOCK_SEC,
    },
  };
}
