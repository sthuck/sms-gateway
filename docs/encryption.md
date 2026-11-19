# Message body encryption (STH-20)

Per-user envelope encryption for SMS bodies at rest.

## Key hierarchy

- **KEK** (key-encryption key): 32-byte secret from a file (`KEK_FILE`), identified by `KEK_ID`.
- **DEK** (data-encryption key): 32-byte key per user, generated on first encrypt, stored wrapped in `user_keys`.
- Cipher: **AES-256-GCM**, random 12-byte nonce, AAD = `owner_id | device_id | device_msg_id`.

Blob layout: `version(1) | dek_version(uint16 BE) | nonce(12) | ciphertext|tag`.

## Config

| Env | Default | Meaning |
| --- | --- | --- |
| `ENCRYPTION_ENABLED` | `true` in production, else `false` | When true, require `KEK_FILE` |
| `KEK_FILE` | — | Path to exactly 32 raw bytes |
| `KEK_ID` | `kek-1` | Id stored on newly wrapped DEKs |
| `KEK_PREVIOUS` | empty | `oldId:/path,olderId:/path` for unwrap during rotation |
| `DEK_CACHE_TTL_MS` | `300000` | In-process DEK cache TTL (5 min) |
| `DEK_CACHE_MAX_ENTRIES` | `10000` | Cache size cap |

Startup fails clearly if encryption is enabled and the KEK file is missing or not 32 bytes.

Helm: mount the KEK as a file (see `deploy/helm/sms-gateway`) and set `KEK_FILE` / `KEK_ID`. Prefer a file mount over putting raw key material in an env var.

## Failure mode

- KEK/DEK load or unwrap failure → `InfrastructureError` → ingest **retryable 5xx**, reads **503**.
- Tampered / wrong-key blob → `DecryptionError` (never empty/garbage body).

## Rotation runbook

### KEK rotation (cheap — no message rewrite)

1. Generate a new 32-byte key file; deploy it alongside the old one.
2. Set `KEK_ID` to the new id, `KEK_FILE` to the new path, and `KEK_PREVIOUS=oldId:/old/path`.
3. Roll pods so every process can unwrap with the previous KEK and wrap with the new one.
4. For each owner, run KEK re-wrap (tested helper `rotateKekForOwner`, or `pnpm --filter @sms-gateway/backend encryption:rotate-kek -- --owner <uuid>`).
5. Confirm `user_keys.kek_id` is the new id for all rows.
6. Remove the old key from `KEK_PREVIOUS` and delete the old secret.

### DEK rotation (per user)

1. Call `rotateDekForOwner` — inserts a new `dek_version`; old versions remain so historical blobs still decrypt.
2. Run `reencryptMessagesForOwner` in batches until `done` (resume with `afterId`).
3. Optionally delete obsolete `user_keys` rows only after you are sure no ciphertext references them (not automated).

## Crypto-shred

`DeleteUserData` deletes `user_keys` for the owner (DEKs destroyed), then deletes the user row (CASCADE removes owned data). Any leftover ciphertext in backups becomes undecryptable without the DEK.

## Search

See [ADR 0002](./adr/0002-encrypted-body-search.md): server-side decrypt-then-filter, owner-scoped and bounded; no blind index for now.
