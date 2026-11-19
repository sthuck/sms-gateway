# Web UI

Minimal React (Vite + TypeScript) owner UI for SMS Gateway — **part A**:
scaffold, OIDC login, and device pairing (Linear **STH-16**). Part B (inbox,
devices list, tokens) adds routes under the same layout/nav.

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

## Pairing page

1. `POST /v1/pairing-codes` (MFA session enforced by the backend).
2. Show QR (`qr_payload`) + short code + countdown to `expires_at`.
3. Poll `GET /v1/devices` every ~2.5s; a new active device id → success.
4. Expired / regenerate / MFA `401 mfa_required` are shown in-page.

## Deploy

Helm currently ships API/worker/MCP only — no web image yet. Build static
output with `pnpm --filter @sms-gateway/web build` (`web/dist`) when wiring
ingress same-origin serving later.
