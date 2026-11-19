# Web UI

Minimal React (Vite + TypeScript) owner UI for SMS Gateway (Linear **STH-16**).

**Part A:** scaffold, OIDC login, device pairing.

**Part B:** inbox (list, search, message detail + delete), devices list (rename,
revoke), personal access tokens (create once / revoke), nav + home links.

## Same-origin API (cookies + CSRF)

The browser talks to `/v1/*` on the **same origin** as the SPA. Session
(`sms_session`, httpOnly) and CSRF (`sms_csrf`) cookies from the backend login
callback therefore apply to API calls; unsafe methods send `X-CSRF-Token` from
the CSRF cookie. Locally, Vite proxies `/v1` → `http://127.0.0.1:8080`. In
production, serve the built static assets and the API behind one host (e.g.
`https://sms.sthuck.info`). Set `OIDC_REDIRECT_URI` and `PUBLIC_BASE_URL` to
that same origin (local Vite: `http://localhost:5173/...`).

## Local run

```bash
# From repo root (Postgres + API already running; see docs/local-dev.md)
pnpm install
pnpm --filter @sms-gateway/web dev
# http://localhost:5173
```

For OIDC through the Vite host, point the backend at the proxied callback:

```bash
OIDC_REDIRECT_URI=http://localhost:5173/v1/auth/callback
PUBLIC_BASE_URL=http://localhost:5173/
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

(Authentik dev blueprint already allows `http://localhost:5173/v1/auth/callback`.)

```bash
pnpm --filter @sms-gateway/web typecheck
pnpm --filter @sms-gateway/web lint
pnpm --filter @sms-gateway/web test
pnpm --filter @sms-gateway/web build
```

## Config (no secrets in the bundle)

| Variable                | Purpose                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | Optional absolute API origin. Leave empty for same-origin / Vite proxy.                                             |
| `VITE_APK_DOWNLOAD_URL` | Optional APK / install-instructions URL. **Placeholder until Android release publishes one** — do not invent a URL. |
| `VITE_DEV_API_PROXY`    | Dev-only proxy target (default `http://127.0.0.1:8080`).                                                            |
| `VITE_CSRF_COOKIE_NAME` | CSRF double-submit cookie name read for unsafe API calls (default `sms_csrf`).                                      |

## Pairing page

1. `POST /v1/pairing-codes` (MFA session enforced by the backend).
2. Show QR (`qr_payload`) + short code + countdown to `expires_at`.
3. Poll `GET /v1/devices?limit=100` every ~2.5s; a new active device id → success.
4. Expired / regenerate / MFA `401 mfa_required` are shown in-page.

## Inbox, devices, tokens

- **Inbox** — `GET /v1/messages` with filters; opaque `next_cursor` pagination.
  Body search may return a short page with more cursor pages — use **Keep
  searching** while `next_cursor` is set.
- **Devices** — `GET /v1/devices?limit=100`, rename (`PATCH`), revoke (`POST …/revoke`).
- **Tokens** — list/create/revoke; the secret is shown once in-page (not stored in
  the browser).

Session boot uses `GET /v1/auth/me`; server/network errors during boot show
**Retry** without clearing an existing session (401 still means sign-in required).

## Deploy

`backend/Dockerfile` builds `web/dist` and bundles it at `/app/web-dist`, which
the Fastify API serves on the same origin when `WEB_DIST_DIR` is set.
`deploy/helm/sms-gateway` configures `config.WEB_DIST_DIR=/app/web-dist` on the
API Deployment by default (set `config.WEB_DIST_DIR=""` to run API-only). Build
standalone static output anytime with `pnpm --filter @sms-gateway/web build`
(`web/dist`).
