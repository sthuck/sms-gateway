# Device pairing and signed-request auth

Companion to Linear **STH-14** and the STH-5 contracts in
`docs/contracts/`. Implementation lives under `backend/src/device/` and
`backend/src/routes/{pairing-codes,devices}.ts`.

## Flow

1. **Owner** (session cookie or bearer JWT) calls `POST /v1/pairing-codes`.
2. API returns a Crockford Base32 code (`XXXX-XXXX`) and
   `qr_payload` = `smsgw://pair?code=…` with optional `server=<url-encoded
   API base URL>` (from `DEVICE_API_PUBLIC_URL` / `PUBLIC_BASE_URL`).
3. Only a **SHA-256 hash** of the normalized code (uppercase, no hyphen)
   is stored in `pairing_codes`. TTL default **5 minutes**.
4. **Device** calls `POST /v1/devices/pair` with the code, ES256 SPKI
   public key, device info, and a proof-of-possession signature
   (`DEVICE_ID` empty in the canonical string). No user session.
5. Server looks up the code via `app.lookup_pairing_code`, verifies the
   signature, then under `withOwner` **atomically burns** the code
   (`UPDATE … WHERE used_at IS NULL`) before inserting `devices` +
   `device_credentials`. Concurrent pair attempts: exactly one wins.
6. Later device requests carry `X-Device-Id` + signing headers; middleware
   resolves the owner via `app.lookup_device_for_auth` and runs handlers
   under `withOwner`.

Alphabet: Crockford Base32 (`0-9A-Z` except `I L O U`), **8 characters**
(~40 bits). Combined with rate limits below, online guessing is
impractical.

## Rate limits (`POST /v1/devices/pair`)

Postgres table `app.rate_limit_buckets` (shared across instances).

| Control | Default | Env |
| --- | --- | --- |
| Per source IP | 10 / 60 s | `PAIR_RATE_LIMIT_PER_IP`, `PAIR_RATE_LIMIT_WINDOW_SEC` |
| Global invalid codes | 120 / 60 s | `PAIR_GLOBAL_INVALID_LIMIT`, `PAIR_GLOBAL_INVALID_WINDOW_SEC` |
| IP lock after invalids | 20 fails → 900 s lock | `PAIR_IP_INVALID_LOCK_THRESHOLD`, `PAIR_IP_INVALID_LOCK_SEC` |

Client IP comes from Fastify `request.ip` with `TRUST_PROXY` set to an
**explicit proxy IP/CIDR list** (preferred) or a hop count (`1` = one hop).
Default is trust nothing. Do not set `TRUST_PROXY=true` (trusts every hop;
clients can spoof `X-Forwarded-For`). **XFF is never parsed by hand.**

**Why Postgres, not in-memory:** an in-memory Fastify rate-limit store
would not enforce correctly with multiple API replicas. No Redis in the
stack yet; a small shared table is enough for v1.

Responses include `RateLimit-Limit` / `Remaining` / `Reset`. `429` also
sets `Retry-After`.

## Replay cache

Table `app.device_replay_cache` stores `(identity, kind, value_hash)` for
**360 seconds** (`DEVICE_REPLAY_TTL_SECONDS`). Identity is the device UUID,
or SHA-256 of the SPKI DER at pairing. Both **nonce** and **signature**
are claimed **atomically after signature verification**
(`INSERT … ON CONFLICT … WHERE expired RETURNING`) so concurrent copies of
the same signed request yield exactly one success. Shared across instances
for the same reason as rate limits.

## Device auth middleware

Verification order matches `docs/contracts/device-signing.md`
(raw body hash, skew ±300 s, `device_unknown` before verify, replay,
signature, then revoke check). Raw JSON bytes are captured by the
content-type parser (no re-serialisation). `Content-Encoding` →
`400 invalid_request`.

- Device principals may call ingestion routes (registered in STH-15 via
  `deviceAuthPreHandler()`) and `GET /v1/devices/me`.
- User session/JWT is cleared on device-only routes and never accepted
  as a substitute for a signature.
- Device signatures alone cannot satisfy `requireUserAuth` user
  endpoints.

## Revoke

`POST /v1/devices/{id}/revoke` (owner session/JWT): sets
`devices.status = revoked` and `device_credentials.revoked_at`. Status is
**re-read from Postgres on every device request** (no status cache), so
the next signed request fails immediately (`403 device_revoked` on write
routes; `GET /v1/devices/me` still returns `200` + `status: revoked` per
contract). Other owners' devices → `404 not_found` under RLS.

## Audit

| Action | `actor_type` | Notes |
| --- | --- | --- |
| `device.pair` | `device` | `actor_id` = new device id; `ip` recorded |
| `device.revoke` | `user` | `actor_id` = owner id; `ip` recorded |

## Local / emulator

Point the Android `dev` flavour at the real backend:

```text
http://10.0.2.2:8080
```

Ensure `DEVICE_ALLOWED_HOSTS` includes `10.0.2.2:8080` (included in local
defaults) and optionally set
`DEVICE_API_PUBLIC_URL=http://10.0.2.2:8080` so the QR `server` parameter
matches. See `docs/local-dev.md`.

## Logging

Never log pairing codes, public/private keys, signatures, or message
bodies. Device id, owner id, error codes, and hash prefixes are fine.
