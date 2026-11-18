# Local development

## Prerequisites

- Docker and Docker Compose v2
- Node.js 22+ and pnpm 9+
- (Optional) Android emulator for end-to-end device API checks

## Quick start

From the repository root:

```bash
# Start Postgres + backend API
docker compose up --build

# Or with the OpenAPI mock server as well
docker compose --profile mock up --build
```

Worker service (STH-12) is included in Compose; scale with
`docker compose up --build --scale worker=2`. Metrics: `http://localhost:9090/metrics`.
Migrate once first (`SMS_APP_PASSWORD` required) so `sms_app` + `pgboss` exist —
see Migrations below and `docs/queue.md`.

| Service | Host port | Emulator URL | Notes |
| --- | --- | --- | --- |
| Backend API | **8080** | `http://10.0.2.2:8080` | Fastify; listens on `0.0.0.0` |
| Worker | **9090** | n/a | pg-boss consumer; metrics at `/metrics` |
| Postgres | **5432** | n/a (internal) | User/db/password: `sms` / `sms` / `sms` (local only) |
| Device API mock (Prism) | **4010** | `http://10.0.2.2:4010` | Profile `mock`; see below |

Health checks:

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
```

## Backend without Docker

```bash
cd backend
pnpm install
cp .env.example .env   # edit DATABASE_URL if needed
pnpm dev               # API on 0.0.0.0:8080
```

Separate stubs:

```bash
pnpm worker   # pg-boss consumer (needs migrate:up first)
pnpm mcp      # MCP server stub
```

Tests and lint:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Device API mock (Prism)

The mock is generated from `docs/contracts/device-api.yaml` (STH-5 v1
draft 2) using [Prism](https://github.com/stoplightio/prism). **Port
4010 is required** — it matches the OpenAPI `servers` entry and the
Android `dev` flavour host `10.0.2.2:4010` used in the signing canonical
string (`devHostVector`).

```bash
docker compose --profile mock up mock-api
# → http://localhost:4010  (emulator: http://10.0.2.2:4010)
```

Or without Compose:

```bash
npx @stoplight/prism-cli mock docs/contracts/device-api.yaml -h 0.0.0.0 -p 4010
```

The contract documents a cleartext-HTTP exception for this emulator
mock only. Production remains HTTPS.

### Signature verification is not enforced on the Prism mock

Prism (and any pure OpenAPI mock) validates request **shape** against the
schema. It does **not** verify ECDSA request signatures, timestamps,
nonces, or content hashes described in `docs/contracts/device-signing.md`.
Treat mock responses as contract scaffolding only.

The real backend (`:8080`) implements pairing, device registration, and
signed-request verification (STH-14). Prefer it for end-to-end pairing
from the emulator. See `docs/pairing.md`.

## Android emulator networking

The Android emulator reaches the host machine at `10.0.2.2`. Point the
app at:

- Real local API (pairing + signatures): `http://10.0.2.2:8080`
- Contract mock (shape only): `http://10.0.2.2:4010`

Both Compose services bind `0.0.0.0` so the emulator can connect.

To pair against the real backend from the emulator:

1. Start Compose (`docker compose up --build`) and run migrations.
2. Configure OIDC (or use a session from the web UI) and issue a code via
   `POST /v1/pairing-codes`.
3. Set `DEVICE_API_PUBLIC_URL=http://10.0.2.2:8080` so the QR `server`
   parameter matches the host the app will call.
4. Ensure `DEVICE_ALLOWED_HOSTS` includes `10.0.2.2:8080` (local default).
5. Scan the QR / enter the code in the Android `dev` flavour.

## Signing test vector

```bash
node docs/contracts/examples/gen-test-vector.mjs
```

Must exit 0. The embedded keypair is a **throwaway test vector**.

## Migrations

With Compose Postgres running:

```bash
cd backend
export MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms
export DATABASE_URL="$MIGRATE_DATABASE_URL"
# Required — local-dev-only value. migrate:up fails if unset.
export SMS_APP_PASSWORD=sms_app
pnpm migrate:up
```

This applies the Drizzle baseline (`backend/drizzle/`), creates role
`sms_app` (password set only on first create), tables, RLS, lookup
functions, and bootstraps `pgboss` (see `docs/queue.md`). The API should
then use `DATABASE_URL=postgres://sms_app:sms_app@localhost:5432/sms`.
See `docs/schema.md` and `backend/drizzle/README.md`.

**Existing local DB** that already ran the old node-pg-migrate CJS files:

```bash
pnpm migrate:stamp   # marks baseline applied; does not re-run DDL
```

There is **no** `migrate:down` (Drizzle has no down). Recreate the DB or
restore a backup. Never use `drizzle-kit push`.

Integration tests expect the same URLs (or `APP_DATABASE_URL` for the app
role) and an explicit `SMS_APP_PASSWORD`. They run against a real Postgres
(Compose locally; service container in CI).

## Authentik (OIDC) — optional profile

Default Compose stays light (Postgres + backend only). Authentik runs from a
**separate override file** and the `authentik` profile:

```bash
docker compose -f docker-compose.yml -f docker-compose.authentik.yml --profile authentik up
```

| Service | Host port | Notes |
| --- | --- | --- |
| Authentik UI / issuer | **9000** | `http://127.0.0.1:9000` |
| Authentik Postgres | internal | DEV-ONLY password `authentik-dev-only` |
| Authentik Redis | internal | |

All Authentik secrets in Compose and the **dev** blueprint are **DEV-ONLY** —
never reuse them outside local development, and never import the prod
blueprint into local Compose (or the reverse).

| Blueprint | Path |
| --- | --- |
| Dev (local only) | `deploy/authentik/blueprints/sms-gateway-oidc-dev.yaml` — auto-mounted by Compose |
| Prod (homelab) | `deploy/authentik/blueprints/sms-gateway-oidc-prod.yaml` — **not** mounted in local Compose; `metadata.labels.blueprints.goauthentik.io/instantiate: "false"` so a directory mount cannot auto-apply it. Apply only via controlled import — see `docs/deployment-auth.md` |

Compose mounts **only** the dev blueprint file (not the whole `blueprints/`
directory). It also sets `AUTHENTIK_BLUEPRINT_CLIENT_SECRET` and
`AUTHENTIK_BLUEPRINT_DEV_USER_PASSWORD` for the dev blueprint `!Env` tags.

### Create the OIDC application (manual steps)

Application **slug** is always `sms-gateway`. Prefer importing
**`sms-gateway-oidc-dev.yaml` only**. If import fails for your Authentik
version, create the app manually:

1. Open `http://127.0.0.1:9000` and sign in as the bootstrap admin
   (`akadmin@example.com` / `dev-only-akadmin-password`).
2. Create an **OAuth2/OpenID Provider**:
   - Name: `SMS Gateway (dev)`
   - Client type: Confidential
   - Client ID: `sms-gateway`
   - Client secret: `dev-only-oidc-client-secret` (DEV-ONLY; matches Compose env)
   - Redirect URIs (**localhost only** — no production host on the dev client):
     - `http://127.0.0.1:8080/v1/auth/callback`
     - `http://localhost:8080/v1/auth/callback`
     - (web Vite, if used) `http://localhost:5173/v1/auth/callback`
   - Scopes: `openid`, `profile`, `email`
3. Create an **Application** with slug **`sms-gateway`** pointing at that provider.
4. Create a test user (e.g. `sms-dev` / `dev-only-sms-user-password`) and
   enrol TOTP/WebAuthn on the default authentication flow (MFA is enforced
   in Authentik; the API also checks `amr`/`acr` when `REQUIRE_MFA=true`).
5. Local issuer URL:

```text
http://127.0.0.1:9000/application/o/sms-gateway/
```

Confirm discovery:

```bash
curl -sS "http://127.0.0.1:9000/application/o/sms-gateway/.well-known/openid-configuration" | head
```

Homelab hostnames and Helm wiring: `docs/deployment-auth.md`.

### Backend env for local OIDC

Copy `backend/.env.example` and set (DEV-ONLY values shown):

```bash
OIDC_ISSUER_URL=http://127.0.0.1:9000/application/o/sms-gateway/
OIDC_CLIENT_ID=sms-gateway
OIDC_CLIENT_SECRET=dev-only-oidc-client-secret
OIDC_REDIRECT_URI=http://127.0.0.1:8080/v1/auth/callback
OIDC_SCOPES=openid profile email
SESSION_SECRET=dev-only-session-secret-min-32-chars!!
OIDC_ALLOW_INSECURE=true
REQUIRE_MFA=true
MFA_CLAIMS_MISSING=deny
PUBLIC_BASE_URL=http://127.0.0.1:8080/
CORS_ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:5173
DATABASE_URL=postgres://sms_app:sms_app@localhost:5432/sms
SMS_APP_PASSWORD=sms_app
```

Then:

```bash
export SMS_APP_PASSWORD=sms_app
pnpm --filter @sms-gateway/backend migrate:up
pnpm --filter @sms-gateway/backend dev
# Browser: http://127.0.0.1:8080/v1/auth/login
```

See `docs/adr/0001-oidc-authentik.md` and `docs/deployment-auth.md`.

