# Android outbox retention and encryption

Defaults live in `UploadDefaults` and are shown on the status screen.

| Knob | Default | Behaviour |
|------|---------|-----------|
| `MAX_OUTBOX_ROWS` | 2 000 | Cap on **pending** rows. When exceeded, oldest pending rows are **parked** with `over_cap` (never deleted silently). |
| `OUTBOX_TTL_MS` | 7 days | Pending rows older than the TTL are **parked** with `expired_ttl`. |
| Parked rows | — | Visible on the status screen with `lastError`; user can tap **Retry parked messages**. |

Housekeeping runs on enqueue, on each uploader pass, and on cold start.

## Encryption at rest

**Decision (this PR):** SMS bodies remain **plaintext in Room**. The app already documents plaintext outbox storage; enabling SQLCipher / EncryptedFile for Room would be a larger schema and migration change and is deferred.

**Follow-up:** encrypt outbox bodies at rest (or the whole DB) before any large inbox backfill (STH-17), and revisit once device-protected vs credential-encrypted storage choices for background work are settled (STH-47).
