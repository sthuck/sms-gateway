# ADR 0001: User authentication via generic OIDC (Authentik)

## Status

Accepted (STH-9)

## Context

The SMS Gateway holds OTPs and bank alerts. User authentication for the web UI
and owner API must support MFA and isolate data with Postgres RLS
(`app.owner_id`). The architecture left the IdP choice open; the product owner
selected **self-hosted Authentik**, integrated only as a **generic OIDC client**
so the IdP can be swapped by configuration.

## Decision

### Provider

- Run Authentik in the homelab (Helm chart of Authentik, not bundled into
  `deploy/helm/sms-gateway`).
- Integrate with discovery (`/.well-known/openid-configuration`), authorization
  code + PKCE (S256), and state/nonce validation.
- **No Authentik SDK and no Authentik-specific Admin APIs** in application code.
- Select the provider purely by env: issuer URL, client id/secret, scopes,
  claim mapping, MFA policy.

### Library choice

- **`openid-client` (v6)** for the browser login dance: maintained by panva,
  implements discovery, PKCE, authorization code grant, and ID-token
  state/nonce checks without vendor lock-in.
- **`jose`** for API bearer JWT verification against the provider JWKS
  (signature, `iss`, `aud`, `exp`, `nbf`, allowed algs). `jose` is the same
  author’s JWT stack and caches/rotates JWKS keys. We keep JWT verification
  explicit so API auth does not depend on a browser redirect client.

### Identity mapping

- Users are **not** keyed by email or a single IdP subject column.
- `(issuer, sub)` maps to `users.id` via `user_identities` (STH-8).
- First login provisions `users` + `user_identities` in one `withOwner`
  transaction (client-generated UUID so RLS `WITH CHECK` can pass).
- Later logins reuse the same row.
- **Auto-link by email is off by default** (`AUTO_LINK_BY_EMAIL=false`).
  Linking on email alone risks account takeover when an IdP asserts an
  unverified or colliding address. Operators may enable it deliberately.

### MFA

- Enrolment and step-up are enforced in Authentik.
- The backend additionally checks `amr` / `acr` when present:
  - `REQUIRE_MFA` defaults **true in production**, false otherwise.
  - `MFA_CLAIMS_MISSING=allow|deny` — default **deny** when MFA is required.
- On success we record `users.mfa_enrolled` and `users.last_auth_method`.

### Session vs bearer

| Surface | Credential | Store |
| --- | --- | --- |
| Web UI | httpOnly + Secure + SameSite=Lax session cookie | Postgres `sessions` (session id **hashed** at rest; revoke on logout) |
| API clients | `Authorization: Bearer` JWT from the IdP | Stateless verify via JWKS |

CSRF for cookie-authenticated state-changing requests: SameSite=Lax plus
double-submit (`sms_csrf` cookie + `x-csrf-token` header) and Origin/Referer
checks when those headers are present.

After authentication, handlers run inside `withOwner` so `app.owner_id` is set
for the request transaction. `request.ownerId` is exposed as a Fastify
decorator. Device-signed and agent (API key / OAuth) routes are out of scope.

## Consequences

- Local dev can run Authentik under a Compose profile without weighing down the
  default stack.
- Swapping to another OIDC IdP is a config change (issuer, client, claims).
- Operators must configure Authentik MFA flows; the API will reject logins that
  lack MFA evidence when `REQUIRE_MFA` is on.
