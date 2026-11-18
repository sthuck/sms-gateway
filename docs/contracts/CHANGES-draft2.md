# STH-5 device API contract — v1 draft 2 changelog

Android review applied. Primary signing test vector is unchanged.

## Limits and packing

- Per-message `body` cap raised from 8 192 to 32 768 Unicode characters (`maxLength`, docs, `body_too_large` text).
- Batch limits unchanged: 100 messages and 1 MiB raw body.
- Clients pack batches by bytes (and item count) to stay under both limits.

## Pairing QR

- URI is `smsgw://pair?code=<code>`.
- Optional `server=<url-encoded base URL>` so the app need not hardcode a backend.
- Request `Host` must match the signed canonical `HOST` and be an allowed backend host.

## Errors

- `401 invalid_timestamp` (`retryable: true`) now includes a standard `Date` response header and a `server_time` field (Unix seconds integer) in the problem+json body, so the app can compute a clock offset and re-sign.
- New `401 device_unknown` (`retryable: false`) for an unknown or deleted `X-Device-Id` (e.g. Keystore key loss/restore). Returned before signature verification. Client clears its credential and prompts re-pairing.
- Draft-1 name `device_not_found` was replaced by `device_unknown` (same case, Android's name). Both codes are not present together.
- `403 device_revoked` follows the same client path (clear credential, prompt re-pair), except `GET /v1/devices/me`, which still returns `200` + `status: revoked` after a valid signature.
- Security note: `device_unknown` before signature verification leaks whether a device id exists. That is unavoidable (no public key to verify against). Device ids are server-issued UUIDs, so enumeration is not practical.

## Transport and signing bytes

- Production and the prod flavour remain HTTPS only.
- Documented dev exception: the Android `dev` flavour talks to the mock over cleartext HTTP at `http://10.0.2.2:4010`. Canonical `HOST` is `10.0.2.2:4010` (kept as sent, lowercased, port included).
- OpenAPI `servers` adds that dev entry.
- Request bodies are signed over the exact bytes sent on the wire (no re-serialisation). Clients must not gzip/compress request bodies. `Content-Encoding` on requests is not supported in v1 and is rejected with `400 invalid_request`. `X-Content-SHA256` covers those exact bytes.

## Resolved decisions (from Android)

- App minSdk 26; contract floor remains API 23.
- `device_msg_id` is a client-derived deterministic opaque string: `sms-` plus truncated SHA-256 over direction, sender, SMSC timestamp, body, and an ordinal, up to 128 characters.
- Outbound SMS is not captured in v1; the `direction` enum is kept.
- `sim_slot` is the slot index, null when unknown (schema was already nullable; description clarified).
- `received_at` is UTC ISO 8601 with a `Z` suffix.
- No Play Integrity and no TLS pinning in v1. A private CA can be added as a trust anchor by the app.
- Backfill uses the same batch endpoint; the client honours `429` + `Retry-After` and treats `duplicate` as success.
- Device name is `"<manufacturer> <model>"` at pairing, renamable in the UI. Pairing examples updated to `"Google Pixel 8"`.

## Fixtures and versioning

- OpenAPI version bumped 0.1.0 → 0.2.0.
- Changelog note at the top of `device-signing.md` and `semantics.md`: "v1 draft 2, Android review applied".
- Existing `test-vector.json` keys and the frozen primary signature are unchanged.
- Additive `devHostVector` added (Host `10.0.2.2:4010`) in `gen-test-vector.mjs` and `test-vector.json`.

## Verification

- `node docs/contracts/examples/gen-test-vector.mjs` — VERIFY OK (primary + dev-host).
- `npx @redocly/cli lint docs/contracts/device-api.yaml` — valid.
