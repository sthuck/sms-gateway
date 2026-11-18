# RCA: STH-46 / STH-48 / STH-50 — infrastructure errors surfaced as auth failures

**Bug head:** `17b5dd6` (STH-46 catch-all) · **Follow-ups:** STH-48 (JWKS/IdP HTTP status),
STH-50 (kid-less / `JWKSMultipleMatchingKeys`)
**Citations below are relative to the fixed PR head unless noted.**

## Cause

PR B introduced a new `try/catch` around session and bearer resolution in the
HTTP adapter, plus a helper `mapAuthError` that treated **every** non-`AuthError`
as HTTP 401.

On `main`, `requireUserAuth` called `lookupSession` / `resolveOwnerFromIdentity`
**without** a surrounding catch. A Postgres throw reached Fastify’s global error
handler → `500 internal_error` `retryable: true`.

On `17b5dd6`, the hexagonal wiring wrapped those calls and `mapAuthError`
(`auth-plugin.ts`) did:

```ts
if (err instanceof AuthError) {
  /* 401 / mfa */ return;
}
sendProblem(reply, "unauthorized", 401, fallbackDetail); // ← BUG
```

Call sites: bearer + session. The **error class was lost at the adapter catch**,
not in the port (`null` already meant not-found only).

**STH-48 (same class, HTTP-status infra):** even after STH-46’s rethrow fix,
JWKS endpoints returning **500 / 503 / 404 / non-JSON** and IdP `/token`
returning **500 / 502 / 503 / non-JSON** still became 401/400 because
jose/openid-client surface those as generic `JOSEError` / `ClientError`, which
use cases mapped to `AuthError` / `invalid_callback`. Transport failures
(refused/reset) were already classified; **response-status** failures were not.

**STH-50 (kid-less regression):** a JWT **without `kid`** against a JWKS with
multiple keys raises jose’s `JWKSMultipleMatchingKeys`. That is a **credential**
failure (ambiguous key selection / client presented an unkeyed token), not
infrastructure. Classifying by **message text** (or treating all jose errors as
infra) incorrectly turned it into **500**. Fix: classify by **jose error class**
(`instanceof JWKSMultipleMatchingKeys` / credential branch) → **401**. Unknown
`kid` remains 401.

## Blast radius

| Surface                                             | Bug behaviour              | Fixed                                                    |
| --------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| Session/bearer **DB** error                         | 401 (`17b5dd6`)            | 500 retryable                                            |
| JWKS HTTP 5xx / 404 / non-JSON                      | 401 (main + early head)    | 500 retryable (STH-48)                                   |
| IdP `/token` HTTP 5xx / non-JSON                    | 400 (main + early head)    | 500 retryable (STH-48)                                   |
| Bad JWT / kid-less+multi-key JWKS / `invalid_grant` | 401 / 400                  | 401/400 (STH-50: never 500 for JWKSMultipleMatchingKeys) |
| OIDC unset → `/me`                                  | 503 on `17b5dd6`           | 401                                                      |
| Login without pool                                  | 503 on `17b5dd6`           | 302                                                      |
| CSRF reject → `last_seen_at`                        | touched early on `17b5dd6` | touch after CSRF                                         |
| Device lookup / replay / pair / queue DB            | (must stay 500)            | `InfrastructureError` + `mapDeviceError` rethrow (B2)    |

## Audit table

| Area                                       | Infra                                                                    | Not found / invalid                      | Collapse?      |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------- | -------------- |
| Session / identity / user DB               | `InfrastructureError` via `withDbInfra`                                  | `null` → AuthError                       | No             |
| Bearer JWT verify                          | JWKS transport **and** HTTP 5xx/404/non-JSON → `InfrastructureError`     | claim/sig/exp / kid-less multi-key → 401 | No (STH-48/50) |
| OIDC finish                                | `/token` transport **and** status≥500 / non-JSON → `InfrastructureError` | invalid_grant/state/nonce → 400          | No (STH-48)    |
| Device lookup / replay / pair / rate limit | `InfrastructureError` via `withDbInfra`                                  | null / replay / DeviceError codes        | No (B2)        |
| Queue publish / worker                     | `InfrastructureError` (pg-boss / DB); retry/DLQ unchanged                | N/A                                      | No (B2)        |
| `mapAuthError` / `mapDeviceError`          | rethrows non-domain errors                                               | maps AuthError / DeviceError only        | Fixed          |

## Fix

1. `mapAuthError` rethrows non-`AuthError`.
2. `InfrastructureError` + `withDbInfra` on PG repos (auth + B2 device/pairing/replay/rate-limit).
3. Use cases rethrow infra (`resolve-bearer.ts`, `complete-login.ts`, device use cases).
4. `jwt.ts`: classify JWKS HTTP/document failures as infra (STH-48); keep
   `JWKSMultipleMatchingKeys` on the credential path (STH-50).
5. `oidc-provider.ts`: `isOidcTokenInfrastructureFailure` for `/token` 5xx/non-JSON.
6. B2: `mapDeviceError` mirrors `mapAuthError`; pairing/device routes never map
   infra to `device_unknown` / `invalid_pairing_code`.

## Prevention (honest)

| Guard                                               | What it actually catches                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP matrix (`test/auth/failure-modes.test.ts`)     | **Primary guard** — DB, JWKS HTTP (incl. 404/non-JSON), IdP `/token` HTTP, device auth DB, pairing DB, CSRF touch                                                                                                                                                                                                                                                                   |
| Parity matrix (`test/device/parity-matrix.test.ts`) | Documents pairing/device/queue status-code outcomes expected on main                                                                                                                                                                                                                                                                                                                |
| Port contracts (all repo methods + B2 ports)        | `withDbInfra` swallow / null-for-error on every method                                                                                                                                                                                                                                                                                                                              |
| `lint:auth-errors`                                  | Tripwire for catch→AuthError/unauthorized, `.catch(()=>null)`, and `mapAuthError`-style 401 fallthrough across `src/adapters` + `src/application` (+ composition). **Not sufficient alone** — it did not originally catch STH-46 until helpers were scanned; keep relying on the HTTP matrix. It also **cannot** prove JWKS/IdP HTTP classification or jose class-vs-message rules. |
| Architecture allow-lists                            | Import boundaries only                                                                                                                                                                                                                                                                                                                                                              |

The CSRF/`last_seen_at` test seeds an old timestamp, waits 350ms after reject
(so a fire-and-forget early touch would commit), and includes a positive
control that a successful `/me` advances `last_seen_at`.
