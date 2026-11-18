# Message ingestion (STH-15)

`POST /v1/messages:batch` accepts signed device batches, normalises
fields, upserts idempotently, and publishes `message.created` for new
rows only. Contract: `docs/contracts/device-api.yaml` and
`docs/contracts/semantics.md`. Auth: `docs/pairing.md` /
`docs/contracts/device-signing.md`.

## Flow

1. Device auth (`requireDeviceAuth`) verifies ES256 signature, skew,
   nonce/replay, and revocation. Request-level failures return RFC 9457
   `application/problem+json` and process no items.
2. Size checks: raw body ≤ 1 MiB (`payload_too_large`); `messages.length`
   ≤ 100 (`batch_too_large`); empty `messages` → `invalid_request`.
3. Per-device rate limits (Postgres `app.rate_limit_buckets`):
   - requests / window (default 60 / 60 s)
   - message volume / window (default 10 000 / 3600 s)
   Exceeded → `429 rate_limited` with `Retry-After` and `RateLimit-*`.
4. Each item is validated independently. Invalid items become
   `status: rejected` with a per-item code; the HTTP status stays `200`.
5. Inside one `withOwner` transaction:
   - `INSERT … ON CONFLICT (device_id, device_msg_id) DO NOTHING RETURNING id`
   - new row → `accepted` + `publishInTx(message.created)` (IDs only)
   - conflict → `duplicate` with the existing server `id` (no second event)
   - `devices.last_seen_at = now()`
6. Response `{ results: [...] }` in request order.

Owner and device ids come **only** from the device credential. Payload
fields such as `owner_id` / `device_id` are ignored.

## Normalisation

| Field | Rule |
| --- | --- |
| `sender` | E.164 via `libphonenumber-js` when the value looks like a phone number and is possible for `INGEST_DEFAULT_PHONE_REGION` (default `US`). Alphanumeric sender IDs (e.g. `BankAlert`) are kept raw. Leading `+` is preserved. |
| `received_at` | ISO 8601 UTC with a `Z` suffix (optional fractional seconds ≤ 6 digits). Values more than 24 hours in the future → `invalid_field`. Past timestamps allowed (backfill). |
| `sim_slot` | Integer 0–9, or null/omitted. |
| `direction` | `inbound` \| `outbound`. |
| `body` | UTF-8; empty allowed; max 32 768 Unicode characters (`body_too_large`). |
| `device_msg_id` | 1–128 chars; stable across retries. Duplicates within one batch → `duplicate_in_batch`. |

## Idempotency

Uniqueness key: `(device_id, device_msg_id)`.

- First insert: `accepted` + one `message.created` event.
- Later retries: `duplicate`, same server `id`, fields not updated, no
  extra event.
- Concurrent identical batches: `ON CONFLICT DO NOTHING RETURNING`
  ensures each row and event is created at most once.

A rolled-back transaction leaves neither the message row nor the queue
job (`publishInTx` shares the same Postgres transaction).

## Rate limits

Configurable env (see `backend/.env.example`):

| Env | Default | Meaning |
| --- | --- | --- |
| `INGEST_RATE_LIMIT_PER_DEVICE` | 60 | Requests per device per window |
| `INGEST_RATE_LIMIT_WINDOW_SEC` | 60 | Request window (seconds) |
| `INGEST_MESSAGE_RATE_LIMIT` | 10000 | Messages per device per window |
| `INGEST_MESSAGE_RATE_WINDOW_SEC` | 3600 | Message-volume window (seconds) |
| `INGEST_DEFAULT_PHONE_REGION` | `US` | Default region for national numbers |

Counters are Postgres-backed (same helper as pairing) so multiple API
replicas share limits.

## Body encryption seam

```ts
encryptBody(ownerId, plaintext) -> Buffer
```

Writes into `messages.body_ciphertext`. **STH-15 uses an identity /
passthrough placeholder** (UTF-8 bytes). Per-user envelope encryption
is STH-20. Never log bodies or senders.

## Android emulator → real backend

From the emulator, post a signed batch to the Compose API (not the
Prism mock):

```text
http://10.0.2.2:8080/v1/messages:batch
```

Canonical `HOST` must be `10.0.2.2:8080` (included in
`DEVICE_ALLOWED_HOSTS` by default). Pair first (`docs/local-dev.md`),
then sign each request per `docs/contracts/device-signing.md`. The
Prism mock on `:4010` does **not** verify signatures or persist
messages.

## Benchmark (measured on this Cloud Agent VM)

**Not production hardware.** Numbers below were measured on the Cursor
Cloud Agent VM against a local API + Postgres stack (same schema and
signing path as Compose).

### Environment

| Item | Value |
| --- | --- |
| Host | Cursor Cloud Agent VM (Linux x86_64), **not production hardware** |
| Date | 2026-11-18 |
| CPUs | 4 |
| Node | v22.23.4 |
| Postgres | 16.15 (local cluster; same roles/schema as Compose) |
| API | `pnpm exec tsx src/index.ts` on `0.0.0.0:8080`, DB role `sms_app` |
| Batch size | 100 messages / request |
| Auth | ES256 signed requests (fresh nonce each iteration; test-vector key) |
| Iterations | warm-up 5 + measure 30 |

### Command

```bash
# Postgres migrated; API listening on :8080 with DEVICE_ALLOWED_HOSTS including 127.0.0.1:8080
cd backend
pnpm exec tsx bench/ingest-batch.ts \
  --base-url http://127.0.0.1:8080 \
  --host 127.0.0.1:8080 \
  --iterations 30 \
  --warmup 5 \
  --batch-size 100
```

Equivalent Compose path: `docker compose up --build`, migrate, then the
same command against `http://127.0.0.1:8080` (Compose publishes 8080).

### Results (measured on this VM)

| Metric | Value |
| --- | --- |
| p50 | **85.56 ms** |
| p95 | **102.67 ms** |
| p99 | 104.71 ms |
| mean | 85.21 ms |
| min / max | 73.17 / 104.71 ms |
| iterations | 30 |
