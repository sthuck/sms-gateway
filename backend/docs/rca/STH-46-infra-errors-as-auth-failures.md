# RCA: STH-46 — infrastructure errors surfaced as auth failures

**Reviewed head (bug):** `17b5dd6` · **This document cites the fixed PR head.**

## Cause

PR B introduced a new `try/catch` around session and bearer resolution in the
HTTP adapter, plus a helper `mapAuthError` that treated **every** non-`AuthError`
as HTTP 401.

On `main`, `requireUserAuth` called `lookupSession(pool, …)` /
`resolveOwnerFromIdentity(pool, …)` **without** a surrounding catch. A Postgres
throw reached Fastify’s global error handler → `500 internal_error`
`retryable: true` (`composition/build-app.ts` error handler).

On `17b5dd6`, the hexagonal wiring wrapped those calls:

1. `PgSessionRepository.lookupBySessionIdHash` / identity lookup throw a raw `Error`
   (or pg error) when the pool fails.
2. `ResolveSession.execute` / `ResolveBearer.execute` let that throw through
   (only domain absence becomes `AuthError`).
3. `requireUserAuth` caught it and called `mapAuthError(..., fallbackDetail)`.
4. `mapAuthError` on `17b5dd6` (`auth-plugin.ts` L200–214) did:

   ```ts
   if (err instanceof AuthError) {
     /* 401 / mfa */ return;
   }
   sendProblem(reply, "unauthorized", 401, fallbackDetail); // ← BUG L214
   ```

   Call sites: bearer catch L132–133; session catch L156–157.

So a DB blip became `"Session expired or revoked"` or
`"Missing or invalid access token"` with `retryable: false`.

**Where the error class was lost:** the adapter catch boundary, not the port.
Ports already used `null` = not found; they did not return null for errors. The
adapter **discarded** the thrown error’s type and substituted an auth problem.

### End-to-end chain (session cookie + DB down)

| Step            | Module                                  | What happens                                                     |
| --------------- | --------------------------------------- | ---------------------------------------------------------------- |
| HTTP            | `auth-plugin.ts` `requireUserAuth`      | cookie present → `resolveSession.execute`                        |
| Use case        | `resolve-session.ts` L17–21             | `sessions.lookupBySessionIdHash`                                 |
| Port            | `SessionRepository`                     | contract: `null` = miss; throw = infra                           |
| Adapter         | `session-repository.ts` → `withDbInfra` | pool throws → `InfrastructureError` (fixed head)                 |
| Plugin catch    | `auth-plugin.ts` L158–162               | `mapAuthError`                                                   |
| Bug (`17b5dd6`) | `mapAuthError` fallback                 | **401 unauthorized**                                             |
| Fix (this head) | `auth-plugin.ts` L212–220               | rethrow non-`AuthError` / `InfrastructureError` → global **500** |

Bearer path is the same shape: `resolveBearer.execute` → identity lookup →
plugin catch → (was) 401 / (now) rethrow → 500
(`auth-plugin.ts` L122–131).

## Blast radius

| Surface                                | On `17b5dd6`             | On `main` / fixed head      |
| -------------------------------------- | ------------------------ | --------------------------- |
| Session resolve DB error               | 401 non-retryable        | 500 retryable               |
| Bearer identity DB error               | 401 non-retryable        | 500 retryable               |
| OIDC unset → `/v1/auth/me`             | 503 `auth_misconfigured` | 401 (config absence)        |
| OIDC set, pool null → `/v1/auth/login` | 503                      | 302 (login needs OIDC only) |
| CSRF reject → `last_seen_at`           | touched early            | untouched until after CSRF  |

Client impact: SPA/Android treat 401 as “re-login”, discard valid sessions, and
hide outages from 5xx alerting. Fail-closed (no auth bypass), but wrong status.

## Audit table (infra vs not-found vs invalid)

| Area                            | Infra today                                         | Not found / invalid                     | Collapses?                      | vs `main`                                                 |
| ------------------------------- | --------------------------------------------------- | --------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| Session lookup (port/use case)  | `InfrastructureError` via `withDbInfra`             | `null` → `AuthError` unauthorized       | No (fixed)                      | Match (500)                                               |
| Bearer JWT verify               | JWKS/network → `InfrastructureError` in jwt adapter | JOSE claim/sig → `AuthError` 401        | No for DB; JWT crypto still 401 | Match main for bad token; JWKS timeout now 5xx (stricter) |
| Bearer identity lookup          | `InfrastructureError`                               | `null` → unauthorized                   | No (fixed)                      | Match                                                     |
| OIDC finish (callback)          | network → `InfrastructureError` → 500               | protocol/state → `invalid_callback` 400 | No for infra                    | Match main for protocol; IdP network → 5xx                |
| OIDC start (login)              | catch → 500 retryable                               | n/a                                     | No                              | Match                                                     |
| CSRF / oauth state cookie       | seal/open throws → 400 path                         | mismatch → 403 csrf                     | No                              | Match                                                     |
| Device `lookup_device_for_auth` | throw → global 500                                  | `null` → `device_unknown` 401           | No                              | Match                                                     |
| Replay / rate-limit buckets     | catch rethrows                                      | `"replay"` / denied                     | No                              | Match                                                     |
| Pairing issue                   | catch → 500                                         | n/a                                     | No                              | Match                                                     |
| Queue publish / worker          | rethrow → retry/DLQ                                 | invalid payload fails job               | No                              | Match                                                     |
| `mapAuthError`                  | rethrows non-`AuthError`                            | only maps `AuthError`                   | **Was yes on 17b5dd6**          | Fixed to match main                                       |

## Fix

1. `mapAuthError` rethrows anything that is not `AuthError`
   (`auth-plugin.ts` L212–220).
2. Introduce `InfrastructureError` (`domain/errors.ts` L11–34); DB adapters wrap
   via `withDbInfra` (`adapters/db-postgres/infra.ts` L3–9).
3. Use cases rethrow infra (`resolve-bearer.ts` L23–27; `complete-login.ts`
   analogous).
4. Login without pool still builds `StartLogin`; OIDC-off `/me` returns 401;
   touch `last_seen_at` only after CSRF (`auth-plugin.ts` after bindAuth).

## Prevention

| Guard                                   | Location                                                               |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Typed infra vs domain errors            | `domain/errors.ts`, port JSDoc                                         |
| Port contract + fault injection         | `test/ports/repository-contracts.test.ts`                              |
| HTTP matrix (session / bearer / device) | `test/auth/failure-modes.test.ts`                                      |
| Catch→401 structural lint + fixture     | `scripts/check-auth-error-classification.mjs`, `pnpm lint:auth-errors` |
| Architecture note                       | `docs/architecture-layers.md` § Error classification                   |

Tests covering the drifts fail on `17b5dd6` (catch-all `mapAuthError`) and pass
on this head.
