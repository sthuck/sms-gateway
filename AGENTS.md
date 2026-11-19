# AGENTS.md

Repository guidance for coding agents working in **SMS Gateway** (private monorepo).

## Project Overview

SMS Gateway forwards incoming SMS from an Android app to a self-hosted backend where each owner can view/search their own messages, define rule/AI **streams**, and grant scoped read access to scripts/agents.

### Current Implementation State

(Note: the root `README.md` still reflects early skeleton status; rely on the code and docs below.)

- **Implemented:**
  - **Backend (`backend/`):** Fastify 5 API (Node 22, ESM TypeScript), Postgres 16 + Drizzle ORM migrations + `FORCE RLS`, OIDC/MFA browser sessions + Bearer JWTs, read-only owner PATs (`smsg_pat_…`, default-deny), device pairing + ES256 signed requests + Postgres replay cache & rate limits, batch SMS ingestion (`POST /v1/messages:batch`), per-user AES-256-GCM envelope encryption (`user_keys` + file KEK), owner REST API for messages, devices, streams (CRUD + RE2 rule preview), and PATs, plus pg-boss queue infrastructure and worker entrypoint.
  - **Web UI (`web/`):** React 19 + TypeScript + Vite SPA with OIDC login, device pairing (QR + short code + polling), inbox (filters, decrypted body search, cursor pagination, message detail/delete), devices (list/rename/revoke), and PAT management (create once / revoke).
  - **Android (`android/`):** Kotlin + Jetpack Compose + Hilt + Room (v4) + WorkManager app (`com.sthuck.smsgateway`): `SmsReceiver` + multipart PDU reassembly, Room outbox + `content_key_counters`, WorkManager batch uploader (`≤100` msgs / `≤1 MiB`), Android Keystore ES256 signing, QR / deep-link (`smsgw://pair`) pairing, `specialUse` keepalive foreground service, and signed GitHub Releases + Obtainium pipeline.
- **Stubs / Deferred:**
  - `backend/src/mcp.ts`: MCP server entrypoint stub (no SDK tools/transport yet).
  - `backend/src/adapters/queue-pgboss/handlers/{message-created,stream-reclassify}.ts`: stub handlers that log IDs only (stream worker classification pending).
  - `POST /v1/devices/me/heartbeat`: draft contract only (`docs/contracts/device-heartbeat-draft.md`); Android `BuildConfig.HEARTBEAT_ENABLED` is `false`.
  - Web UI deployment in Helm (`deploy/helm/sms-gateway/` currently deploys API, worker, and MCP only).

## Monorepo Layout

| Path | Purpose |
| --- | --- |
| `backend/` | `@sms-gateway/backend` — Fastify API, pg-boss worker, MCP stub, Drizzle schema/migrations, Vitest suite |
| `web/` | `@sms-gateway/web` — React/Vite owner SPA |
| `android/` | Standalone Gradle project (root is `android/`) for the Kotlin/Compose app |
| `docs/` | Architecture, schema, encryption, pairing, queue, local-dev, Android release docs, ADRs |
| `docs/contracts/` | Source-of-truth OpenAPI specs (`device-api.yaml`, `user-api.yaml`), signing spec, and frozen test vector |
| `deploy/helm/sms-gateway/` | Helm chart for API / worker / MCP Deployments (Postgres not bundled) |
| `deploy/authentik/blueprints/` | Dev (local Compose only) and prod Authentik OIDC blueprints |
| `REVIEW.md` | Medium/minor/UX review findings and known tech debt (HIGH items live in Linear team `STH`) |
| `.github/workflows/` | Path-filtered CI (`ci.yml` aggregate `CI success`, plus `backend.yml`, `web.yml`, `android-ci.yml`, `android-release.yml`, `docs.yml`, `helm.yml`) |

### Tooling Prerequisites

- Node.js `>=22`, `pnpm@9.15.0` (workspace covers `backend` and `web` via `pnpm-workspace.yaml`)
- Docker / Docker Compose v2 (Postgres 16, optional Prism mock on `:4010`, optional Authentik on `:9000`)
- JDK 17 + Android SDK platform `37.2` + Build-Tools `36.0.0` (for `android/`)
- Helm v3 (`deploy/helm/sms-gateway/`) and `@redocly/cli@1` (OpenAPI lint)

## Commands & Verification

Run the checks matching the areas you touched (mirrors `.github/workflows/ci.yml` and `android-ci.yml`).

### Root Shortcuts (`package.json`)

```bash
pnpm install                  # install backend + web workspace deps
pnpm lint                     # backend lint (eslint + prettier + lint:arch + lint:auth-errors)
pnpm typecheck                # backend typecheck
pnpm test                     # backend vitest run
pnpm web:typecheck            # web typecheck
pnpm web:lint                 # web eslint + prettier
pnpm web:test                 # web vitest run
pnpm web:build                # web tsc + vite build
```

### Backend (`backend/` or `pnpm --filter @sms-gateway/backend <script>`)

```bash
pnpm lint                     # eslint . && prettier --check . && pnpm lint:arch && pnpm lint:auth-errors
pnpm lint:fix                 # eslint --fix + prettier --write
pnpm typecheck                # tsc -p tsconfig.json --noEmit
pnpm build                    # tsc -p tsconfig.build.json
pnpm drizzle:check            # snapshot drift + monotonic journal when + repo-wide push guard
pnpm migrate:up               # requires MIGRATE_DATABASE_URL and SMS_APP_PASSWORD; bootstraps pgboss
pnpm migrate:stamp            # cutover for existing legacy CJS DB only (no DDL)
pnpm schema:equivalence       # asserts legacy+stamp ≡ drizzle baseline (needs Postgres)
pnpm catalog:write            # regenerate drizzle/expected-catalog.json after clean migrate:up
pnpm test                     # vitest run (fileParallelism: false; DB suites share Postgres)
```

- DB integration tests read `MIGRATE_DATABASE_URL` (default `postgres://sms:sms@127.0.0.1:5432/sms`), `APP_DATABASE_URL` (default `postgres://sms_app:sms_app@127.0.0.1:5432/sms`), and `SMS_APP_PASSWORD` (default local-dev `sms_app` inside test helpers; `scripts/migrate.mjs` itself has **no** default and fails fast if unset). In CI (`CI=true`), an unreachable Postgres fails tests rather than skipping.

### Web (`web/` or `pnpm --filter @sms-gateway/web <script>`)

```bash
pnpm typecheck
pnpm lint                     # eslint . && prettier --check .
pnpm test                     # vitest run (jsdom + Testing Library)
pnpm build
pnpm dev                      # http://localhost:5173 (proxies /v1 → http://127.0.0.1:8080)
```

### Android (`android/`)

```bash
./scripts/check-room-schema.sh
./gradlew assembleDevDebug lintDevDebug testDevDebugUnitTest
git diff --exit-code -- app/schemas       # must be clean after build
./gradlew assembleProdRelease             # unsigned if signing env vars omitted
./scripts/run-connected-dev-debug.sh      # instrumented tests (requires running emulator)
```

- Do **not** run `./gradlew connectedDevDebugAndroidTest` directly for receipt tests — `IncomingSmsReceiptTest` requires the e2e token injected by `scripts/run-connected-dev-debug.sh`.

### Contracts, Helm & Compose

```bash
redocly lint                                              # lints device-api.yaml + user-api.yaml via redocly.yaml
node docs/contracts/examples/gen-test-vector.mjs          # must exit 0 (throwaway signing keypair)
helm lint deploy/helm/sms-gateway
helm template sms-gateway deploy/helm/sms-gateway >/dev/null
docker compose -f docker-compose.yml config -q
docker compose -f docker-compose.yml -f docker-compose.authentik.yml --profile authentik config -q
```

## Backend Architecture & Hard Invariants

### Hexagonal Architecture (Ports & Adapters)

Enforced by `backend/.dependency-cruiser.cjs` (`pnpm lint:arch`). Dependencies point **inward only**:

| Layer | Path | Allowed imports |
| --- | --- | --- |
| Domain | `src/domain/` | `src/domain/` only (pure TS, no I/O, no npm packages) |
| Ports | `src/ports/` | `src/domain/` + `src/ports/` |
| Application | `src/application/use-cases/` | `src/domain/` + `src/ports/` + `src/application/` (never `src/config.ts`, `src/app.ts`, Fastify, pg, Drizzle, etc.) |
| Adapters | `src/adapters/*` | Domain, ports, application, frameworks (`http-fastify`, `db-postgres`, `auth-oidc`, `body-codec`, `device-crypto`, `ingest`, `key-wrapper`, `phone`, `queue-pgboss`, `re2`) |
| Composition | `src/composition/` | Wiring only (`build-app.ts`, `build-auth.ts`, `build-device.ts`, `build-encryption.ts`, `build-streams.ts`) |

- `src/device/` and `src/queue/` are thin legacy re-exports kept for import stability; new code must import from `src/adapters/*`.
- When adding a use case or outbound port method: add unit tests in `test/application/` with in-memory fakes and extend `test/ports/repository-contracts.test.ts` (fake + Postgres).
- TypeScript config (`backend/tsconfig.json`): ESM `NodeNext` (always use `.js` extensions on relative imports), `verbatimModuleSyntax: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, inline `type` imports (`@typescript-eslint/consistent-type-imports`), Prettier (`printWidth: 100`, `semi: true`, `singleQuote: false`, `trailingComma: "all"`).

### Error Classification (STH-46 / STH-48 / STH-50)

Read `backend/docs/architecture-layers.md` and `backend/docs/rca/STH-46-infra-errors-as-auth-failures.md` before changing auth/device error paths:

- **Absence vs. outage:** Ports return `null` **only** for domain absence. Infrastructure failures (DB, OIDC/JWKS, KEK/DEK, pg-boss) **must** throw `InfrastructureError` (wrap Postgres calls with `withDbInfra` from `src/adapters/db-postgres/infra.ts`).
- **Never collapse infra into auth failure:** Use cases must never convert `InfrastructureError` into `AuthError`/`DeviceError`. HTTP error mappers must rethrow non-domain/infra errors so Fastify's global error handler returns `500 internal_error` (`retryable: true`) — never `401`/`403`/`device_unknown`.
- **Classify third-party errors by error class/code**, never by error message text.
- **Guards:** `pnpm lint:auth-errors` (`backend/scripts/check-auth-error-classification.mjs`, structural tripwire) + HTTP fault matrix in `backend/test/auth/failure-modes.test.ts`.
- **HTTP error format:** Always emit RFC 9457 `application/problem+json` via `sendProblem()` in `src/adapters/http-fastify/problems.ts`.

### Auth, CSRF & PAT Default-Deny (STH-57)

- User/owner guards live in `backend/src/adapters/http-fastify/auth-plugin.ts`:
  - `requireUserAuth` / `requireOwnerWriteAuth`: accepts session cookie (with `Origin` + double-submit `X-CSRF-Token` check on unsafe methods) or OIDC Bearer JWT. **Rejects owner PATs with `403 forbidden` by default.**
  - `requireOwnerReadAuth`: also accepts owner PATs (`smsg_pat_<uuid>_<secret>`), **strictly limited** to `OWNER_PAT_READ_ALLOWLIST`: `GET /v1/messages`, `GET /v1/messages/:id`, `GET /v1/devices`.
  - Keep `OWNER_PAT_READ_ALLOWLIST`, route `preHandler`s, and `bearerAuth` security annotations in `docs/contracts/user-api.yaml` synchronized — `backend/test/auth/pat-route-matrix.test.ts` asserts parity across every secured OpenAPI route.
- Device endpoints use `deviceAuthPreHandler()` (`src/adapters/http-fastify/device-plugin.ts`), verifying ES256 signatures over captured raw JSON body bytes, replay cache, and live DB revocation status (never cached). User credentials are never accepted on device routes, and device signatures never satisfy user routes.
- Client IP must come from Fastify `request.ip` configured via `TRUST_PROXY` — never parse `X-Forwarded-For` manually.

### Postgres, Drizzle Migrations & RLS

- **Schema source of truth:** `backend/src/adapters/db-postgres/schema.ts` and `owned-tables.json` (16 owner-scoped tables).
- **Roles:** Privileged migrator (`MIGRATE_DATABASE_URL`) owns tables and runs migrations; runtime API/worker/MCP connect as `sms_app` (`DATABASE_URL`, `NOBYPASSRLS`, no DDL rights).
- **RLS:** Every owned table has `owner_id`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and `owner_isolation` policy (`owner_id = app.current_owner_id()`). All owner queries must run inside `withOwner(pool, ownerId, fn)` (`src/adapters/db-postgres/with-owner.ts`), which executes transaction-local `set_config('app.owner_id', $1, true)`.
- **Pre-owner lookups:** Auth before `owner_id` is known (device auth, pairing code, session, OIDC identity, owner PAT) uses narrow `SECURITY DEFINER` functions in schema `app` with pinned `search_path = pg_catalog, public, app, pg_temp` and `EXECUTE` granted only to `sms_app`. Never broaden them to return message bodies or arbitrary rows.
- **Migration rules:**
  1. Generate SQL with `pnpm drizzle:generate`, then hand-review and add custom SQL Drizzle cannot emit (`FORCE ROW LEVEL SECURITY`, `SECURITY DEFINER` functions, `REVOKE`/`GRANT EXECUTE`).
  2. Apply only via `pnpm migrate:up` (Drizzle has no down migrations). Never touch `backend/migrations-legacy/` for fresh DBs (kept for CI `schema:equivalence` and `migrate:stamp` tests).
  3. **CI Push Guard (`backend/scripts/check-drizzle-drift.mjs`):** Never use Drizzle's schema `push` subcommand or add a `push` npm script. Note that `drizzle:check` scans **all** `.mjs/.js/.cjs/.ts/.tsx/.json/.md/.yml/.yaml` files across the entire repo for the two-word sequence `drizzle-kit` followed by whitespace and `push`, failing on any file/line outside its strict allowlist — do not write that literal two-word phrase in new docs or comments.
  4. Never put non-snapshot `.json` files in `backend/drizzle/meta/` (`expected-catalog.json` intentionally lives in `backend/drizzle/`, outside `meta/`).
  5. Journal `when` values in `backend/drizzle/meta/_journal.json` must strictly increase (`drizzle-orm#5769`).
  6. If baseline grants/roles/policies change, regenerate `backend/drizzle/expected-catalog.json` with `pnpm catalog:write` after a clean `migrate:up`.

### Encryption, Queue & Safe Regex

- **Body encryption (`docs/encryption.md`):** `messages.body_ciphertext` holds AES-256-GCM ciphertext with AAD `owner_id | device_id | device_msg_id` and per-user wrapped DEKs in `user_keys` wrapped by a 32-byte file KEK (`KEK_FILE`). KEK/DEK load/unwrap failures → `InfrastructureError`; tampered blobs → `DecryptionError`.
- **Sensitive data hygiene:** **Never log** SMS bodies, pairing codes, PAT secrets, session IDs, OAuth codes/ID tokens, device signatures, or key material.
- **Queue (`docs/queue.md`):** `pgboss` schema is **not** RLS-protected. Job payloads must contain **IDs only** (strict Zod schemas + forbidden-key guard rejecting `body`, `sender`, `text`, `ciphertext`, etc.). Publish inside the caller's DB transaction via `publishInTx`; make handlers idempotent via `claimProcessed` (`queue_processed_jobs`) inside `withOwner`.
- **Regexes (stream rules):** Always compile user-supplied patterns via `Re2SafeRegexCompiler` (`src/adapters/re2/re2-compiler.ts`, linear-time `re2-wasm` + static guards + haystack length cap). Never pass user patterns directly to JS `RegExp`.

## Web UI (`web/`) Conventions

- Routes (`web/src/App.tsx`): `/login`, `/`, `/inbox`, `/inbox/:messageId`, `/devices`, `/devices/pair`, `/tokens`.
- **Same-origin cookies + CSRF:** Browser talks to `/v1/*` on the same origin (Vite proxies `/v1` → `http://127.0.0.1:8080` locally). Unsafe methods read the `sms_csrf` cookie and send `X-CSRF-Token`.
- **No secrets in client bundle:** Never put secrets in `VITE_*` variables. Leave `VITE_APK_DOWNLOAD_URL` unset/configurable — do not invent a URL.
- **PAT handling:** Show newly created PAT secret once in-page; never persist it in `localStorage`/`sessionStorage`.
- **Session boot resilience:** In `AuthContext`, only `401` (including `mfa_required`) clears the session to anonymous; 5xx/network errors preserve state and display a retry UI.
- **Search pagination:** When `q` is active on `GET /v1/messages`, the backend caps decryption work per request and may return a short page with a non-null `next_cursor`; treat `next_cursor !== null` as more pages to scan ("Keep searching"), not end-of-results.

## Android (`android/`) Conventions

- Package `com.sthuck.smsgateway`; flavours `dev` (`com.sthuck.smsgateway.dev`, default `http://10.0.2.2:4010`, cleartext allowed only for `10.0.2.2`/`localhost`/`127.0.0.1`) and `prod` (`com.sthuck.smsgateway`, `https://sms.sthuck.info`, cleartext forbidden).
- **Room schema discipline (`AppDatabase.kt`):** Current `APP_DATABASE_VERSION = 4` with committed schemas `app/schemas/com.sthuck.smsgateway.data.local.AppDatabase/{2,3,4}.json`. Never enable destructive migration in release builds. Any entity change requires: bump `APP_DATABASE_VERSION`, export & commit the new `<n>.json`, add an explicit `Migration` to `AppDatabase.MIGRATIONS`, and add a `MigrationTestHelper` test.
- **Request signing:** Hardware-backed Keystore ES256 (P-256) keys. Serialize request bodies once so the bytes hashed into `X-Content-SHA256` match the exact bytes OkHttp transmits. Verify changes against `docs/contracts/examples/test-vector.json`.
- **SMS capture & upload:** `SmsReceiver` only writes to Room (`goAsync()` + `Dispatchers.IO`) and never touches the network; WorkManager drains the outbox to `POST /v1/messages:batch`.
- **Privacy:** Never log SMS bodies, senders, pairing codes, or key material. Keep `backup_rules.xml` and `data_extraction_rules.xml` aligned with privacy requirements.

## Contracts, Deployment & Workflow Conventions

- **OpenAPI-first:** `docs/contracts/device-api.yaml` and `docs/contracts/user-api.yaml` are the single source of truth — never duplicate specs under `android/` or `web/`. Keep contracts, backend routes, and contract tests (`backend/test/device/contract.test.ts`, `backend/test/auth/pat-route-matrix.test.ts`) in sync.
- **Authentik blueprints:** Only `deploy/authentik/blueprints/sms-gateway-oidc-dev.yaml` is mounted in local Compose (`docker-compose.authentik.yml`). Dev secrets are local-only; never reuse them or auto-apply `sms-gateway-oidc-prod.yaml` locally.
- **Review findings:** Append medium/minor/UX review notes to `REVIEW.md`; HIGH-severity issues belong in Linear (team `STH`, project "SMS Gateway").
- **Commits:** Use Conventional Commits (`feat(scope): …`, `fix(scope): …`, `docs: …`), referencing Linear ticket IDs (e.g. `(STH-57)`) when relevant.

## Key Documentation Index

- Backend hexagonal architecture & error rules: `backend/docs/architecture-layers.md`, `backend/docs/rca/STH-46-infra-errors-as-auth-failures.md`
- Postgres schema, RLS & Drizzle migrations: `docs/schema.md`, `backend/drizzle/README.md`
- Encryption & search trade-offs: `docs/encryption.md`, `docs/adr/0002-encrypted-body-search.md`
- Auth, OIDC & agent PATs: `docs/adr/0001-oidc-authentik.md`, `docs/deployment-auth.md`, `docs/agent-access.md`
- Pairing, signing & API contracts: `docs/pairing.md`, `docs/contracts/device-signing.md`, `docs/contracts/semantics.md`, `docs/contracts/device-api.yaml`, `docs/contracts/user-api.yaml`
- Queue & worker: `docs/queue.md`
- Local development & mock server: `docs/local-dev.md`
- Android specifics: `android/README.md`, `docs/android-keepalive.md`, `docs/android-outbox-retention.md`, `docs/android/`
- Web UI: `web/README.md`
- Helm chart: `deploy/helm/sms-gateway/README.md`

## Updating This File

As a repository convention, keep the footer below updated with the latest git commit hash this file reflects whenever `AGENTS.md` is edited.

---
Last updated at commit: `af546c904fb5a44caa1e2de80ee5421084d71f32` (`af546c9` — Merge pull request #45 from sthuck/cursor/review-md-consolidate-2b00, 2026-11-19)
