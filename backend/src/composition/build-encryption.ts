import type { Pool } from "pg";
import { AesGcmBodyCodec, DekCache, IdentityBodyCodec } from "../adapters/body-codec/index.js";
import { FileKekWrapper, type EncryptionConfig } from "../adapters/key-wrapper/index.js";
import { PgUserKeyRepository } from "../adapters/db-postgres/user-key-repository.js";
import type { BodyCodec } from "../ports/outbound/body-codec.js";
import type { KeyWrapper } from "../ports/outbound/key-wrapper.js";
import type { UserKeyRepository } from "../ports/outbound/user-key-repository.js";

export type EncryptionStack = {
  bodyCodec: BodyCodec;
  keyWrapper: KeyWrapper | null;
  userKeys: UserKeyRepository | null;
  cache: DekCache | null;
};

/**
 * Build the body codec + key stack.
 * When encryption is enabled, requires a DB pool and a valid KEK file
 * (FileKekWrapper.fromConfig fails fast on missing/invalid keys).
 */
export function buildEncryptionStack(options: {
  config: EncryptionConfig;
  pool: Pool | null;
  bodyCodec?: BodyCodec;
}): EncryptionStack {
  if (options.bodyCodec) {
    return {
      bodyCodec: options.bodyCodec,
      keyWrapper: null,
      userKeys: null,
      cache: null,
    };
  }

  if (!options.config.enabled) {
    return {
      bodyCodec: new IdentityBodyCodec(),
      keyWrapper: null,
      userKeys: null,
      cache: null,
    };
  }

  if (!options.pool) {
    throw new Error(
      "ENCRYPTION_ENABLED requires DATABASE_URL (pool) so per-user DEKs can be stored",
    );
  }

  const keyWrapper = FileKekWrapper.fromConfig(options.config);
  const userKeys = new PgUserKeyRepository(options.pool);
  const cache = new DekCache({
    ttlMs: options.config.dekCacheTtlMs,
    maxEntries: options.config.dekCacheMaxEntries,
  });
  const bodyCodec = new AesGcmBodyCodec({ keyWrapper, userKeys, cache });
  return { bodyCodec, keyWrapper, userKeys, cache };
}
