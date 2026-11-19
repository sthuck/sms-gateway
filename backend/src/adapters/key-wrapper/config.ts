import { z } from "zod";

const boolFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return v === "true" || v === "1" || v === "yes";
  });

const encryptionEnvSchema = z.object({
  /**
   * When true, message bodies are envelope-encrypted and KEK_FILE must point
   * at a 32-byte key file. Default: true in production, false otherwise.
   */
  ENCRYPTION_ENABLED: boolFromEnv.optional(),
  /** Absolute path to a 32-byte KEK file (active key). */
  KEK_FILE: z.string().min(1).optional(),
  /** Identifier recorded on newly wrapped DEKs. */
  KEK_ID: z.string().min(1).default("kek-1"),
  /**
   * Previous KEKs for unwrap during rotation: `id1:/path1,id2:/path2`.
   * Active KEK_ID must not appear here.
   */
  KEK_PREVIOUS: z.string().optional().default(""),
  DEK_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  DEK_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
});

export type PreviousKek = { kekId: string; filePath: string };

export type EncryptionConfig = {
  enabled: boolean;
  kekFile: string | null;
  kekId: string;
  previousKeks: PreviousKek[];
  dekCacheTtlMs: number;
  dekCacheMaxEntries: number;
};

function parsePreviousKeks(raw: string): PreviousKek[] {
  if (!raw.trim()) return [];
  const out: PreviousKek[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0 || colon === trimmed.length - 1) {
      throw new Error(
        `Invalid KEK_PREVIOUS entry "${trimmed}": expected id:/path (colon-separated)`,
      );
    }
    const kekId = trimmed.slice(0, colon).trim();
    const filePath = trimmed.slice(colon + 1).trim();
    if (!kekId || !filePath) {
      throw new Error(`Invalid KEK_PREVIOUS entry "${trimmed}": empty id or path`);
    }
    out.push({ kekId, filePath });
  }
  return out;
}

export function loadEncryptionConfig(
  env: NodeJS.ProcessEnv = process.env,
  extras?: { nodeEnv?: string },
): EncryptionConfig {
  const parsed = encryptionEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid encryption configuration: ${details}`);
  }

  const data = parsed.data;
  const nodeEnv = extras?.nodeEnv ?? env.NODE_ENV ?? "development";
  const enabled =
    data.ENCRYPTION_ENABLED !== undefined ? data.ENCRYPTION_ENABLED : nodeEnv === "production";

  let previousKeks: PreviousKek[];
  try {
    previousKeks = parsePreviousKeks(data.KEK_PREVIOUS);
  } catch (err) {
    throw new Error(
      `Invalid encryption configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const prev of previousKeks) {
    if (prev.kekId === data.KEK_ID) {
      throw new Error(
        `Invalid encryption configuration: KEK_PREVIOUS must not include active KEK_ID "${data.KEK_ID}"`,
      );
    }
  }

  if (enabled) {
    if (!data.KEK_FILE) {
      throw new Error(
        "Invalid encryption configuration: ENCRYPTION_ENABLED requires KEK_FILE (path to a 32-byte key file)",
      );
    }
  }

  return {
    enabled,
    kekFile: data.KEK_FILE ?? null,
    kekId: data.KEK_ID,
    previousKeks,
    dekCacheTtlMs: data.DEK_CACHE_TTL_MS,
    dekCacheMaxEntries: data.DEK_CACHE_MAX_ENTRIES,
  };
}
