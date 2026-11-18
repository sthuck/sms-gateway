# Device heartbeat (draft, STH-47)

**Status:** proposed. Not implemented on the backend. Android client code exists behind `BuildConfig.HEARTBEAT_ENABLED` (default `false`).

## Goal

Let the backend and web UI mark a device silent when heartbeats stop. Complements `last_seen_at` from signed traffic (batch ingest / `GET /v1/devices/me`).

## Proposed endpoint

```http
POST /v1/devices/me/heartbeat
```

- **Auth:** same device signature as other `/v1` device routes (`X-Device-Id`, `X-Timestamp`, `X-Nonce`, `X-Content-SHA256`, `X-Signature`). See `device-signing.md`.
- **Body:** empty. `X-Content-SHA256` is the SHA-256 of the empty byte string (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- **Success:** `204 No Content` (preferred) or `200` with:

```json
{
  "ok": true,
  "server_time": 1794995160
}
```

`server_time` is Unix seconds UTC (optional; same role as on `invalid_timestamp`).

- **Errors:** same problem+json vocabulary as the rest of the device API. Revoked devices should follow the `GET /v1/devices/me` precedent (valid signature → `200`/`204` is fine; or `403 device_revoked` if the backend prefers a hard cut — pick one in the backend ticket and keep Android treating auth failures as non-blocking for the outbox).

## Client rules (Android)

- Send only when `BuildConfig.HEARTBEAT_ENABLED` is true and the device is paired.
- Suggested interval: **15 minutes** while the keepalive foreground service is running.
- **404 and 5xx are retryable-ignore:** log/count only; never fail the FGS; never park outbox rows; never delay `MessageUploadWorker`.
- Heartbeat must not share a critical section with the outbox uploader beyond the shared OkHttp client.

## Backend / web follow-up

Track a Backend ticket to:

1. Add the route and update `last_seen_at` (or a dedicated `last_heartbeat_at`).
2. Expose silence in the user API / web UI (e.g. warn when last heartbeat older than 2× interval).
3. Promote this draft into `device-api.yaml` when the server ships.
