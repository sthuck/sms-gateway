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

| Service | Host port | Emulator URL | Notes |
| --- | --- | --- | --- |
| Backend API | **8080** | `http://10.0.2.2:8080` | Fastify; listens on `0.0.0.0` |
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
pnpm worker   # queue worker stub
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

### Signature verification is not enforced

Prism (and any pure OpenAPI mock) validates request **shape** against the
schema. It does **not** verify ECDSA request signatures, timestamps,
nonces, or content hashes described in `docs/contracts/device-signing.md`.
Treat mock responses as contract scaffolding only. Real signature
verification belongs in the backend (future work).

## Android emulator networking

The Android emulator reaches the host machine at `10.0.2.2`. Point the
app at:

- Real local API: `http://10.0.2.2:8080`
- Contract mock: `http://10.0.2.2:4010`

Both Compose services bind `0.0.0.0` so the emulator can connect.

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
export SMS_APP_PASSWORD=sms_app
pnpm migrate:up
```

This creates role `sms_app`, tables, RLS, and lookup functions. The API
should then use `DATABASE_URL=postgres://sms_app:sms_app@localhost:5432/sms`.
See `docs/schema.md` for the ER diagram and roles model.

Integration tests expect the same URLs (or `APP_DATABASE_URL` for the app
role). They run against a real Postgres (Compose locally; service
container in CI).

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

All Authentik secrets in Compose and
`deploy/authentik/blueprints/sms-gateway-oidc.yaml` are **DEV-ONLY** — never
reuse them outside local development.

### Create the OIDC application (manual steps)

If the blueprint does not import cleanly for your Authentik version:

1. Open `http://127.0.0.1:9000` and sign in as the bootstrap admin
   (`akadmin@example.com` / `dev-only-akadmin-password`).
2. Create an **OAuth2/OpenID Provider**:
   - Name: `SMS Gateway (dev)`
   - Client type: Confidential
   - Client ID: `sms-gateway-dev`
   - Client secret: `dev-only-oidc-client-secret`
   - Redirect URIs:
     - `http://127.0.0.1:8080/v1/auth/callback`
     - `http://localhost:8080/v1/auth/callback`
     - (web Vite, if used) `http://localhost:5173/v1/auth/callback`
   - Scopes: `openid`, `profile`, `email`
3. Create an **Application** `sms-gateway` pointing at that provider.
4. Create a test user (e.g. `sms-dev` / `dev-only-sms-user-password`) and
   enrol TOTP/WebAuthn on the default authentication flow (MFA is enforced
   in Authentik; the API also checks `amr`/`acr` when `REQUIRE_MFA=true`).
5. Issuer URL is typically:

```text
http://127.0.0.1:9000/application/o/sms-gateway/
```

Confirm discovery:

```bash
curl -sS "http://127.0.0.1:9000/application/o/sms-gateway/.well-known/openid-configuration" | head
```

### Backend env for local OIDC

Copy `backend/.env.example` and set (DEV-ONLY values shown):

```bash
OIDC_ISSUER_URL=http://127.0.0.1:9000/application/o/sms-gateway/
OIDC_CLIENT_ID=sms-gateway-dev
OIDC_CLIENT_SECRET=dev-only-oidc-client-secret
OIDC_REDIRECT_URI=http://127.0.0.1:8080/v1/auth/callback
OIDC_SCOPES=openid profile email
SESSION_SECRET=dev-only-session-secret-min-32-chars!!
OIDC_ALLOW_INSECURE=true
REQUIRE_MFA=true
MFA_CLAIMS_MISSING=deny
PUBLIC_BASE_URL=http://127.0.0.1:8080/
DATABASE_URL=postgres://sms_app:sms_app@localhost:5432/sms
```

Then:

```bash
pnpm --filter @sms-gateway/backend migrate:up
pnpm --filter @sms-gateway/backend dev
# Browser: http://127.0.0.1:8080/v1/auth/login
```

See `docs/adr/0001-oidc-authentik.md` and `docs/deployment-auth.md`.
