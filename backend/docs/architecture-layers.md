# Backend ports & adapters (hexagonal)

PR B introduces package-by-layer layout for the **user-auth** slice.
Behaviour is unchanged; later PRs (B2/C) migrate pairing/device, queue,
and ingestion onto the same pattern.

## Layers

| Layer       | Path                                  | May depend on                          |
| ----------- | ------------------------------------- | -------------------------------------- |
| Domain      | `src/domain/`                         | Nothing outside domain (pure TS)       |
| Ports       | `src/ports/`                          | Domain types only                      |
| Application | `src/application/use-cases/`          | Domain + ports                         |
| Adapters    | `src/adapters/*`                      | Domain, ports, application, frameworks |
| Composition | `src/composition/`                    | Everything (wiring only)               |
| Entrypoints | `src/index.ts`, `worker.ts`, `mcp.ts` | Composition + thin bootstrap           |

Dependency rule: **inward only**. Domain and application never import
Fastify, `pg`, `drizzle-orm`, `openid-client`, `jose`, or adapter modules.

Enforced by `dependency-cruiser` (`pnpm lint:arch`) and a negative proof
in `test/architecture/`.

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

## Logging

Never log request bodies or tokens (pino redaction + request child logger
strips body). Auth adapters must not log codes, ID tokens, or session ids
in plaintext.
