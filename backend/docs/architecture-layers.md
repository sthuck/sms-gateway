# Backend ports & adapters (hexagonal)

PR B introduced package-by-layer layout for the **user-auth** slice.
PR **B2** migrates **pairing**, **device auth**, and the **queue** onto the
same pattern. Behaviour is unchanged. Later PR **C** covers ingestion.

## Layers

| Layer       | Path                                  | May depend on (allow-list)             |
| ----------- | ------------------------------------- | -------------------------------------- |
| Domain      | `src/domain/`                         | `src/domain` only (pure TS)            |
| Ports       | `src/ports/`                          | `src/domain` + other ports             |
| Application | `src/application/use-cases/`          | `src/domain` + `src/ports` (+ self)    |
| Adapters    | `src/adapters/*`                      | Domain, ports, application, frameworks |
| Composition | `src/composition/`                    | Everything (wiring only)               |
| Entrypoints | `src/index.ts`, `worker.ts`, `mcp.ts` | Composition + thin bootstrap           |

Dependency rule: **inward only**, enforced as allow-lists in
`.dependency-cruiser.cjs` (`pnpm lint:arch`). Domain/application/ports
must not import adapters, `src/config.ts`, `src/app.ts`, or any npm
package (pg, fastify, openid-client, jose, drizzle-orm, pg-boss, pino,
undici, …). Negative proof lives in `test/architecture/`.

Thin re-exports under `src/device/` and `src/queue/` remain for test
import stability; new code should import from `src/adapters/*`.

## Auth slice map (PR B)

| Concern                                                                                        | Location                 |
| ---------------------------------------------------------------------------------------------- | ------------------------ |
| MFA / claims / session active rules                                                            | `domain/auth/`           |
| StartLogin, CompleteLogin, Logout, GetMe, ResolveSession, ResolveBearer                        | `application/use-cases/` |
| OidcProvider, Session/Identity/User repositories, Clock, IdGenerator, TokenHasher, JwtVerifier | `ports/outbound/`        |
| HTTP routes, plugin, CSRF, problem+json                                                        | `adapters/http-fastify/` |
| `withOwner`, repos, SECURITY DEFINER lookups, Drizzle `schema.ts`                              | `adapters/db-postgres/`  |
| openid-client, jose JWKS, OAuth state cookies, OIDC config                                     | `adapters/auth-oidc/`    |
| `buildApp` / `buildAuthStack`                                                                  | `composition/`           |

## Pairing / device / queue slice map (PR B2)

| Concern                                                                                   | Location                      |
| ----------------------------------------------------------------------------------------- | ----------------------------- |
| Canonical string, pairing normalize/QR, `DeviceError`, device types                       | `domain/device/`              |
| IssuePairingCode, PairDevice, RevokeDevice, GetDeviceMe, ResolveDeviceAuth                | `application/use-cases/`      |
| DeviceAuthRepository, PairingCodeRepository, ReplayCache, PairRateLimiter, QueuePublisher | `ports/outbound/`             |
| Device plugin/routes, pair PoP, raw-body                                                  | `adapters/http-fastify/`      |
| Device/pairing repos, replay cache, rate-limit buckets (`withDbInfra`)                    | `adapters/db-postgres/`       |
| ES256 signing, pairing-code CSPRNG/hash, device config                                    | `adapters/device-crypto/`     |
| pg-boss boss/publish/worker/handlers, `PgBossQueuePublisher`                              | `adapters/queue-pgboss/`      |
| `buildDeviceStack`                                                                        | `composition/build-device.ts` |

## How to add a use case

1. Put pure rules in `domain/` (no I/O).
2. Add or extend an outbound port under `ports/outbound/`.
3. Implement the use case under `application/use-cases/` (constructor-injected ports only).
4. Implement the port in the appropriate adapter.
5. Wire in `composition/build-auth.ts` / `build-device.ts` (or a new composition module).
6. Add `test/application` coverage with in-memory fakes; keep characterization tests green.
7. Extend `test/ports/repository-contracts.test.ts` for every new port method (fake + Postgres).

## How to add an adapter

- Inbound (HTTP): map protocol ↔ use-case DTOs in `adapters/http-fastify/`; never put Fastify types in use cases.
- Outbound (DB/OIDC/queue): implement the port interface; keep `withOwner` semantics
  (`transaction` + `set_config('app.owner_id', $1, true)`, reject empty owner).
- Do not change SECURITY DEFINER lookup SQL signatures.
- Wrap DB/network calls with `withDbInfra` so failures throw `InfrastructureError`.

## Ingestion slice (PR C / STH-15)

| Concern                                                         | Location                        |
| --------------------------------------------------------------- | ------------------------------- |
| Sender / timestamp / sim_slot / direction normalisation         | `domain/message/`               |
| IngestMessageBatch                                              | `application/use-cases/`        |
| MessageRepository, BodyCodec, IngestRateLimiter, QueuePublisher | `ports/outbound/`               |
| `POST /v1/messages:batch`                                       | `adapters/http-fastify/`        |
| Pg message upsert + publishInTx, ingest rate buckets            | `adapters/db-postgres/`         |
| Identity BodyCodec (Phase 2 seam), libphonenumber sender        | `adapters/body-codec`, `phone/` |
| Ingest env (`INGEST_*`)                                         | `adapters/ingest/`              |

## Planned follow-ups

- Body encryption (STH-20) replaces `IdentityBodyCodec`.

## Error classification (STH-46 / STH-48 / STH-50)

| Outcome                                       | Representation                       | HTTP                                        |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Domain absence (not found)                    | `null` from port lookups             | mapped by use case → 401/404 as appropriate |
| Invalid credentials / MFA / CSRF / device PoP | `AuthError` / `DeviceError`          | 401 / 403 / 400                             |
| Infrastructure (DB / JWKS / IdP / pg-boss)    | `InfrastructureError` (never `null`) | 500 / 503 `retryable: true`                 |

Rules:

1. Ports: `null` means absence only; infra MUST throw `InfrastructureError`.
2. Use cases: never catch and convert `InfrastructureError` into `AuthError` / `DeviceError`.
3. HTTP (`mapAuthError` / `mapDeviceError` / routes): rethrow non-domain errors so the
   global handler returns 500 `internal_error` retryable — never collapse into unauthorized /
   `device_unknown`.
4. JWKS / IdP **HTTP status** failures (5xx, non-JSON) are infra (STH-48), not 401/400.
5. Classify third-party failures by **error class / code**, never message text
   (STH-50: `JWKSMultipleMatchingKeys` → 401).
6. **Primary regression guard:** HTTP matrix in `test/auth/failure-modes.test.ts`
   plus `test/device/parity-matrix.test.ts`. Port contracts cover all repository
   methods. `pnpm lint:auth-errors` is a tripwire only (see RCA).

Readable path on this branch: `backend/docs/architecture-layers.md`.
Full RCA: `backend/docs/rca/STH-46-infra-errors-as-auth-failures.md`.

## Logging

Never log request bodies or tokens (pino redaction + request child logger
strips body). Auth adapters must not log codes, ID tokens, or session ids
in plaintext. Pairing routes must not log plaintext pairing codes.
