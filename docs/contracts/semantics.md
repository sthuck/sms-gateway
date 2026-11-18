# Device API semantics (STH-5 v1 draft 2)

Companion to `device-api.yaml` and `device-signing.md`.

**Changelog:** v1 draft 2, Android review applied. Per-message body
cap raised to 32 768; clients pack batches by bytes to stay under
1 MiB and 100 messages; pairing QR may include `server`;
`invalid_timestamp` carries `Date` and `server_time`;
`401 device_unknown` added (`device_not_found` renamed);
cleartext HTTP only for the Android `dev` mock; request bodies signed
over exact wire bytes (no gzip). See Resolved decisions below.

## Idempotency

The idempotency key for a message is `(device_id, device_msg_id)`.

- First valid insert: per-item `status: accepted`, with the new server
  `id`.
- Any later request, from this device, with the same `device_msg_id`:
  per-item `status: duplicate`, with the **existing** server `id`.
  Fields are not updated. This is a no-op and is safe to treat as
  success in the Android queue (drop the row).
- `device_msg_id` must be stable across retries and process death. The
  Android app uses a client-derived deterministic opaque string:
  `sms-` plus a truncated SHA-256 over direction, sender, SMSC
  timestamp, body, and an ordinal, at most 128 characters.
- If the same `device_msg_id` appears more than once in a single
  batch, the first item is processed normally; later copies get
  `rejected` / `duplicate_in_batch`.
- There is no `Idempotency-Key` header. Request-level retries are
  covered by per-item ids plus a new nonce/signature (see signing).

A `200` response with `results` is the only success signal. If the
client times out after the server accepted an item, retrying the same
`device_msg_id` returns `duplicate` rather than a second store.

## Batch limits

| Limit | Value |
| --- | --- |
| Max messages per request | 100 |
| Max request body | 1 048 576 bytes (1 MiB), measured on raw bytes |
| Min messages per request | 1 (`messages` must be a non-empty array) |
| Max `body` characters | 32 768 Unicode characters per message |
| Max `sender` length | 64 |
| Max `device_msg_id` length | 128 |

Exceeding 100 items or 1 MiB is a request-level `413`
(`batch_too_large` or `payload_too_large`). No items are processed.

Clients pack batches by bytes (and item count) to stay under both the
1 MiB raw-body limit and the 100-message limit. A single 32 768
character body is well under 1 MiB, but a full 100-message batch of
large bodies may not be; pack conservatively from the UTF-8 byte
length of the compact JSON that will actually be sent.

A per-item body over 32 768 characters is `rejected` /
`body_too_large`; other items in the batch are still evaluated.

`received_at` must be ISO 8601 UTC with a `Z` suffix. Values more
than 24 hours in the future are `rejected` / `invalid_field`. Past
timestamps are allowed (backfill). Backfill uses this same batch
endpoint; the client honours `429` + `Retry-After` and treats
`duplicate` as success.

## Rate limits

Every response includes `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` (delta-seconds until the window resets). A `429`
also includes `Retry-After` (delta-seconds). Honour `Retry-After` when
present; otherwise back off to `RateLimit-Reset`.

Proposed default policies (configurable at deploy time):

| Endpoint | Default |
| --- | --- |
| `POST /v1/messages:batch` | 60 requests / minute / device, and 10 000 messages / hour / device |
| `GET /v1/devices/me` | 60 requests / minute / device |
| `POST /v1/devices/pair` | 10 requests / minute / source IP |

## Pairing QR

The web UI presents a pairing QR (and the raw code) of the form:

```
smsgw://pair?code=<code>
```

Code format is 8 Crockford Base32 characters, hyphen optional,
case-insensitive (see `PairingCode` in the OpenAPI document).

An optional `server` query parameter may be added, whose value is the
URL-encoded API base URL, so the app does not need a hardcoded
backend:

```
smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fapi.sms-gateway.example
```

The request `Host` must be the host (and port, if any) of that base
URL, must match the host used in the signed canonical string, and
must be one of the server's allowed backend hosts. Production and the
prod flavour use HTTPS; the Android `dev` flavour may use cleartext
HTTP at `http://10.0.2.2:4010`, in which case `Host` is
`10.0.2.2:4010`.

## Error model

Request-level errors use RFC 9457 `application/problem+json` with two
extra fields: `code` (stable, snake_case) and `retryable` (boolean).
`detail` and all logs must **never** include message bodies, pairing
codes, or signatures in full (prefix/length only if needed).

`401 invalid_timestamp` additionally includes a standard `Date`
response header and a `server_time` field (Unix seconds integer) in
the problem+json body, so the app can compute a clock offset and
re-sign. `retryable` remains `true`.

### Request-level codes

| code | HTTP | retryable | When |
| --- | --- | --- | --- |
| `invalid_request` | 400 | no | Malformed JSON, missing required field/header, empty `messages`, schema violation not covered below, or a request `Content-Encoding` header (compression is not supported in v1) |
| `content_hash_mismatch` | 400 | no | `X-Content-SHA256` ≠ SHA-256 of the exact raw body bytes on the wire |
| `invalid_pairing_code` | 400 | no | Missing, malformed, expired, or already used pairing code |
| `invalid_public_key` | 400 | no | Public key is not a valid P-256 SPKI, or `alg` is not `ES256` |
| `invalid_signature` | 401 | no | Signature missing, wrong format, or does not verify. Do not retry the same bytes; fix signing. |
| `invalid_timestamp` | 401 | yes | Outside the ±300 s window. Read `Date` / `server_time`, apply an offset, new timestamp and nonce, resign. |
| `replay_detected` | 401 | yes | Nonce or signature reused in the 360 s window. New nonce, resign. |
| `device_unknown` | 401 | no | Unknown or deleted `X-Device-Id` (e.g. after Keystore key loss or restore). Returned before signature verification. Client must clear its credential and prompt re-pairing. |
| `device_revoked` | 403 | no | Device revoked. Same client path as `device_unknown`: clear credential and prompt re-pair. Not used on `GET /v1/devices/me` (that call returns `200` + `status: revoked` after a valid signature). |
| `payload_too_large` | 413 | no | Body > 1 MiB. Split the batch (pack by bytes). |
| `batch_too_large` | 413 | no | More than 100 items. Split the batch. |
| `rate_limited` | 429 | yes | Honour `Retry-After`. |
| `internal_error` | 500 | yes | Unexpected error. Exponential backoff. |
| `service_unavailable` | 503 | yes | Temporary outage. Honour `Retry-After` if present. |

`device_unknown` replaces the draft-1 name `device_not_found`.

Returning `device_unknown` before signature verification discloses
that a device id is not registered. That existence leak is
unavoidable: there is no public key to verify against for an unknown
id. Device ids are server-issued UUIDs, so enumeration beyond this
is not practical. See `device-signing.md`.

### Per-item codes (HTTP still 200)

| code | Meaning |
| --- | --- |
| `missing_field` | A required field was absent or empty (`device_msg_id`, `sender`, `received_at`, `direction`) |
| `invalid_field` | A field failed validation (bad `direction`, `received_at` not UTC `Z`, `sim_slot` out of range, future timestamp, etc.) |
| `body_too_large` | `body` longer than 32 768 characters |
| `duplicate_in_batch` | The same `device_msg_id` already appeared earlier in this request |

## Retries and backoff (Android)

WorkManager (or equivalent) should keep a local queue and only drop a
row once a `200` result for that `device_msg_id` is `accepted` or
`duplicate`.

| Situation | Action |
| --- | --- |
| Network timeout, no HTTP response | Retry the same messages with a **new** nonce, timestamp, and signature. |
| `200` accepted / duplicate | Drop from the queue (`duplicate` is success). |
| `200` rejected | Do not retry that item; surface `error.detail` in debug. Other items are independent. |
| `400` / `401 invalid_signature` | Do not retry blindly. Signing errors → fix and resign. |
| `401 device_unknown` | Clear the stored credential and prompt re-pairing. Do not retry. |
| `403 device_revoked` | Same path as `device_unknown`: clear credential, prompt re-pair. Exception: `GET /v1/devices/me` still returns `200` + `status: revoked`, after which the app clears and prompts. |
| `401 invalid_timestamp` or `replay_detected` | Retry immediately with a new timestamp/nonce and a new signature (`retryable: true`). For `invalid_timestamp`, apply the offset from `Date` / `server_time`. |
| `413` | Split into smaller batches (≤100 items and ≤1 MiB, packed by bytes) and retry. |
| `429` | Wait `Retry-After` seconds (fallback: `RateLimit-Reset`). Honour this during backfill as well. |
| `500` / `503` | Exponential backoff with full jitter. Suggested: 15 s, 30 s, 1 m, 2 m, 5 m, cap 15 m. Honour `Retry-After` when present. |

Do not overlap in-flight uploads of the same `device_msg_id`.

## Versioning

- All device endpoints live under `/v1`.
- Changes inside `/v1` are **additive only**: new optional fields,
  new endpoints, new error codes (clients must ignore unknown codes
  and unknown JSON properties).
- A breaking change (removing/renaming a field, changing a meaning,
  changing the signing scheme, tightening a previously accepted
  format) requires `/v2` and a new signing scheme version in the
  canonical string (`v2`).
- Clients should send `app_version` at pairing so the backend can
  track compatibility.

## Logging

Message bodies, full pairing codes, private keys, and full signatures
must not appear in logs, traces, queue payloads, or error reports.
`device_msg_id`, sender, timestamps, device id, error codes, and
content-hash prefixes are allowed.

## Resolved decisions

Recorded from the Android review of v1 draft 1. The contract floor
and enums that were already compatible are retained.

1. **minSdk**: the app's minSdk is 26. The signing scheme's contract
   floor remains API 23 (`SHA256withECDSAinP1363Format`).
2. **`device_msg_id`**: a client-derived deterministic opaque string,
   `sms-` plus a truncated SHA-256 over direction, sender, SMSC
   timestamp, body, and an ordinal, at most 128 characters.
3. **Outbound SMS**: not captured in v1 of the app. The `direction`
   enum keeps `inbound` and `outbound` for later use.
4. **SIM identity**: `sim_slot` is the zero-based slot index, and is
   null (or omitted) when unknown. The schema already allows
   `integer` or `null`.
5. **Pairing QR payload**: `smsgw://pair?code=<code>`, plus an
   optional `server=<url-encoded base URL>` so the app need not
   hardcode a backend. The request `Host` must match the signed
   canonical `HOST` and be an allowed backend host.
6. **`received_at`**: UTC ISO 8601 with a `Z` suffix, as specified.
7. **Body length**: per-message cap is 32 768 Unicode characters.
   Batch limits stay at 100 messages and 1 MiB total raw body.
   Clients pack batches by bytes.
8. **Play Integrity**: none in v1. No `integrity_token` field.
9. **TLS pinning**: none in v1. A private CA can be added as a trust
   anchor by the app if the homelab uses one.
10. **Backfill**: uses this same `POST /v1/messages:batch` endpoint.
    The client honours `429` + `Retry-After` and treats `duplicate`
    as success. No separate “backfill complete” signal in v1.
11. **Device display name**: `"<manufacturer> <model>"` (e.g.
    `"Google Pixel 8"`) is sent at pairing and is renamable in the
    web UI.
