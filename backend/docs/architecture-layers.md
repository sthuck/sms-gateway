# Backend ports & adapters (hexagonal)

PR B introduces package-by-layer layout for the **user-auth** slice.
Behaviour is unchanged; later PRs (B2/C) migrate pairing/device, queue,
and ingestion onto the same pattern.

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

## Auth slice map

| Concern                                                                                        | Location                 |
| ---------------------------------------------------------------------------------------------- | ------------------------ |
| MFA / claims / session active rules                                                            | `domain/auth/`           |
| StartLogin, CompleteLogin, Logout, GetMe, ResolveSession, ResolveBearer                        | `application/use-cases/` |
| OidcProvider, Session/Identity/User repositories, Clock, IdGenerator, TokenHasher, JwtVerifier | `ports/outbound/`        |
| HTTP routes, plugin, CSRF, problem+json                                                        | `adapters/http-fastify/` |
| `withOwner`, repos, SECURITY DEFINER lookups, Drizzle `schema.ts`                              | `adapters/db-postgres/`  |
| openid-client, jose JWKS, OAuth state cookies, OIDC config                                     | `adapters/auth-oidc/`    |
| `buildApp` / `buildAuthStack`                                                                  | `composition/`           |

## How to add a use case

1. Put pure rules in `domain/` (no I/O).
2. Add or extend an outbound port under `ports/outbound/`.
3. Implement the use case under `application/use-cases/` (constructor-injected ports only).
4. Implement the port in the appropriate adapter.
5. Wire in `composition/build-auth.ts` (or a new composition module).
6. Add `test/application` coverage with in-memory fakes; keep characterization tests green.

## How to add an adapter

- Inbound (HTTP): map protocol ↔ use-case DTOs in `adapters/http-fastify/`; never put Fastify types in use cases.
- Outbound (DB/OIDC): implement the port interface; keep `withOwner` semantics
  (`transaction` + `set_config('app.owner_id', $1, true)`, reject empty owner).
- Do not change SECURITY DEFINER lookup SQL signatures.

## Planned follow-ups

- **B2** — migrate pairing/device auth and queue into adapters (`http-fastify`,
  `db-postgres`, reserved `queue-pgboss/`).
- **C** — redo STH-15 ingestion on the new structure (do not stack on draft #8).

## Error classification (STH-46)

| Outcome                                  | Representation                        | HTTP                                        |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------- |
| Domain absence (not found)               | `null` from port lookups              | mapped by use case → 401/404 as appropriate |
| Invalid credentials / MFA / CSRF         | `AuthError` (or device problem codes) | 401 / 403                                   |
| Infrastructure (DB / JWKS / IdP network) | `InfrastructureError` (never `null`)  | 500 / 503 `retryable: true`                 |

Rules:

1. Ports: `null` means absence only; infra MUST throw `InfrastructureError`.
2. Use cases: never catch and convert `InfrastructureError` into `AuthError`.
3. HTTP (`mapAuthError` / routes): rethrow non-`AuthError` so the global handler
   returns 500 `internal_error` retryable — never collapse into unauthorized.
4. Enforced by `pnpm lint:auth-errors` (`scripts/check-auth-error-classification.mjs`)
   plus port contract tests under `test/ports/` and HTTP matrix in
   `test/auth/failure-modes.test.ts`.

See `docs/rca/STH-46-infra-errors-as-auth-failures.md`.

## Logging

Never log request bodies or tokens (pino redaction + request child logger
strips body). Auth adapters must not log codes, ID tokens, or session ids
in plaintext.
