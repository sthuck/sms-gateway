# RCA: STH-46 / STH-48 — infrastructure errors surfaced as auth failures

**Bug head:** `17b5dd6` (STH-46 catch-all) · **Follow-up:** STH-48 (JWKS/IdP HTTP status)
**Citations below are relative to the fixed PR head unless noted.**

## Cause

PR B introduced a new `try/catch` around session and bearer resolution in the
HTTP adapter, plus a helper `mapAuthError` that treated **every** non-`AuthError`
as HTTP 401.

On `main`, `requireUserAuth` called `lookupSession` / `resolveOwnerFromIdentity`
**without** a surrounding catch. A Postgres throw reached Fastify’s global error
handler → `500 internal_error` `retryable: true`.

On `17b5dd6`, the hexagonal wiring wrapped those calls and `mapAuthError`
(`auth-plugin.ts` L200–214) did:

```ts
if (err instanceof AuthError) {
  /* 401 / mfa */ return;
}
sendProblem(reply, "unauthorized", 401, fallbackDetail); // ← BUG L214
```

Call sites: bearer L132–133; session L156–157. The **error class was lost at the
adapter catch**, not in the port (`null` already meant not-found only).

**STH-48 (same class, HTTP-status infra):** even after STH-46’s rethrow fix,
JWKS endpoints returning 500/503/404/non-JSON and IdP `/token` returning
500/502/503/non-JSON still became 401/400 because jose/openid-client surface
those as generic `JOSEError` / `ClientError`, which use cases mapped to
`AuthError` / `invalid_callback`. Transport failures (refused/reset) were
already classified; **response-status** failures were not.

## Blast radius

| Surface                          | Bug behaviour              | Fixed                  |
| -------------------------------- | -------------------------- | ---------------------- |
| Session/bearer **DB** error      | 401 (`17b5dd6`)            | 500 retryable          |
| JWKS HTTP 5xx / non-JSON         | 401 (main + early head)    | 500 retryable (STH-48) |
| IdP `/token` HTTP 5xx / non-JSON | 400 (main + early head)    | 500 retryable (STH-48) |
| Bad JWT / `invalid_grant`        | 401 / 400                  | unchanged              |
| OIDC unset → `/me`               | 503 on `17b5dd6`           | 401                    |
| Login without pool               | 503 on `17b5dd6`           | 302                    |
| CSRF reject → `last_seen_at`     | touched early on `17b5dd6` | touch after CSRF       |

## Audit table

| Area                                  | Infra                                                                    | Not found / invalid             | Collapse?         |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------- | ----------------- |
| Session / identity / user DB          | `InfrastructureError` via `withDbInfra`                                  | `null` → AuthError              | No                |
| Bearer JWT verify                     | JWKS transport **and** HTTP 5xx/non-JSON → `InfrastructureError`         | claim/sig/exp → 401             | No (STH-48)       |
| OIDC finish                           | `/token` transport **and** status≥500 / non-JSON → `InfrastructureError` | invalid_grant/state/nonce → 400 | No (STH-48)       |
| Device lookup / replay / pair / queue | throw → 500 / retry                                                      | null / replay codes             | No (matches main) |
| `mapAuthError`                        | rethrows non-`AuthError`                                                 | maps `AuthError` only           | Fixed (STH-46)    |

## Fix

1. `mapAuthError` rethrows non-`AuthError` (`auth-plugin.ts` L212–220).
2. `InfrastructureError` + `withDbInfra` on PG repos.
3. Use cases rethrow infra (`resolve-bearer.ts`, `complete-login.ts`).
4. `jwt.ts`: classify JWKS HTTP/document failures as infra (STH-48).
5. `oidc-provider.ts`: `isOidcTokenInfrastructureFailure` for `/token` 5xx/non-JSON.

## Prevention (honest)

| Guard                                           | What it actually catches                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HTTP matrix (`test/auth/failure-modes.test.ts`) | **Primary guard** — DB, JWKS HTTP, IdP `/token` HTTP, CSRF touch ordering                                       |
| Port contracts (all 11 repo methods)            | `withDbInfra` swallow / null-for-error on every method                                                          |
| `lint:auth-errors`                              | Tripwire for catch→AuthError, `.catch(()=>null)`, and `mapAuthError`-style 401 fallthrough across `src/adapters | application | device | routes | queue`. **Not sufficient alone** — it did not originally catch STH-46 until helpers were scanned; keep relying on the HTTP matrix |
| Architecture allow-lists                        | Import boundaries only                                                                                          |

The CSRF/`last_seen_at` test seeds an old timestamp, waits 350ms after reject
(so a fire-and-forget early touch would commit), and includes a positive
control that a successful `/me` advances `last_seen_at`.
