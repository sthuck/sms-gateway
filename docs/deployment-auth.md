# Deploying Authentik and wiring OIDC

Authentik is **not** part of the `sms-gateway` Helm chart. Install it with the
[official Authentik Helm chart](https://docs.goauthentik.io/install-config/install/kubernetes/),
then point the API at the issuer and client credentials. The homelab runs
authentik 2026.8 next to sms-gateway in the same cluster.

## Hostnames (sthuck homelab)

| Role | URL |
| --- | --- |
| App / API | `https://sms.sthuck.info` |
| Authentik | `https://sso.sthuck.info` |
| Authentik application **slug** | `sms-gateway` |
| OIDC issuer | `https://sso.sthuck.info/application/o/sms-gateway/` |
| Redirect URI (prod) | `https://sms.sthuck.info/v1/auth/callback` |
| CORS origin (prod) | `https://sms.sthuck.info` |

`auth.sthuck.info` (used in earlier versions of these docs) is **not** available:
it points at an unrelated service. Use `sso.sthuck.info`.

Use the same slug (`sms-gateway`) in Authentik, Helm
`config.OIDC_APPLICATION_SLUG`, and the **prod** blueprint.

The issuer has a path (`/application/o/<slug>/`, Authentik's `per_provider`
issuer mode). Both discovery code paths must keep it. v0.2.0 dropped it for JWKS
discovery and the API exited with `OIDC discovery failed: HTTP 404`. Fixed in
v0.2.2 (#47).

Local Compose uses `http://127.0.0.1:9000/application/o/sms-gateway/` — see
`docs/local-dev.md` and the **dev** blueprint only.

## TLS requirements

Both hostnames need certificates that the clients actually trust:

- **`sms.sthuck.info` must be publicly trusted** (e.g. Let's Encrypt). The prod
  Android app's `network_security_config.xml` trusts **system CAs only**, so a
  private/homelab CA is rejected even if installed on the phone.
- **The issuer host must be trusted by the API pods.** The API fetches OIDC
  discovery, JWKS and the token endpoint server-side from Node.js, which uses its
  bundled CA list. Either serve the issuer with a public certificate (what the
  homelab does), or mount the private CA and set `NODE_EXTRA_CA_CERTS` with the
  chart's `extraVolumes` / `extraVolumeMounts` / `extraEnv` (example in
  `deploy/helm/sms-gateway/values.yaml`).

Let's Encrypt via ACME DNS-01 works for LAN-only hostnames, because the CA never
connects to the host.

## Blueprints (dev vs prod)

| File | Use | Redirects | Secrets / users |
| --- | --- | --- | --- |
| `deploy/authentik/blueprints/sms-gateway-oidc-dev.yaml` | Local Compose only (authentik 2024.10) | localhost / 127.0.0.1 | DEV-ONLY via Compose `!Env`; seeded `sms-dev` |
| `deploy/authentik/blueprints/sms-gateway-oidc-prod.yaml` | Homelab / production (tested on authentik 2026.8) | `https://sms.sthuck.info/v1/auth/callback` only | Client secret from `!Env SMS_GATEWAY_OIDC_CLIENT_SECRET`; **no** seeded user |

Local Compose (`docker-compose.authentik.yml`) mounts **only** the
dev blueprint file into `/blueprints/` — not the whole directory — so the
prod file is never visible to Authentik's auto-apply path. The prod
blueprint also sets
`metadata.labels.blueprints.goauthentik.io/instantiate: "false"` as a
belt-and-suspenders guard if it is ever present under a blueprints mount.
Apply it via a controlled import (System → Blueprints), or mount it on purpose
(e.g. via the Authentik chart's `blueprints.configMaps`) with that label removed,
once the env var below is set **on the worker**, which is where blueprints run.

**Never** import the dev blueprint into production Authentik. Dev-only
passwords and client secrets must not be reused outside local Compose.

What the prod blueprint sets, and why each is required on current Authentik:

| Setting | Value | Why |
| --- | --- | --- |
| `authorization_flow` | `default-provider-authorization-implicit-consent` | Required field |
| `invalidation_flow` | `default-provider-invalidation-flow` | Required field (authentik ≥ 2024.10) |
| `grant_types` | `[authorization_code]` | **Model default is `[]`** (only the UI fills in defaults). Without it every login fails: authentik logs `Invalid grant_type for provider` and the callback returns `Invalid OAuth callback` with `error=invalid_request` |
| `redirect_uris` | list: `{matching_mode: strict, url: …/v1/auth/callback}` | The plain-string form is legacy |
| `signing_key` | `authentik Self-signed Certificate` (RSA → RS256) | **Without a key pair, Authentik signs with HS256 using the client secret**, which the backend rejects (`OIDC_ALLOWED_ALGS=RS256,ES256`) |
| `property_mappings` | `openid`, `profile`, `email` scope mappings | Otherwise the email/name claims are missing |
| `sub_mode` | `user_id` | Stable subject |
| `issuer_mode` | `per_provider` | Matches the issuer above |
| `include_claims_in_id_token` | `true` | Claims come from the ID token |

The built-in self-signed certificate expires after one year. Rotating it changes
the JWKS.

## MFA requirements

Production defaults to `REQUIRE_MFA=true` and `MFA_CLAIMS_MISSING=deny`, and the
backend reads the ID token's `amr` claim. On Authentik:

- **`amr` contains `mfa` only if an authenticator-validation stage actually
  ran** in that login. Authentik's `acr` is a constant
  (`goauthentik.io/providers/oauth2/default`) and never reflects MFA.
- The stock `default-authentication-mfa-validation` stage defaults to
  `not_configured_action: skip`, which makes MFA **optional**. Set it to
  `configure` (enrol TOTP/WebAuthn), with device classes `totp`, `webauthn` and
  `static` (recovery codes).
- Keep **`last_auth_threshold: seconds=0`**. A "remember MFA" window skips the
  stage on later logins, `amr` then lacks `mfa`, and login fails with
  `401 mfa_required`.

## Authentik application (production / homelab)

1. Generate the client secret and store it twice: in the Authentik worker's
   environment, and in the `sms-gateway-oidc` Secret that sms-gateway reads.
   Use your cluster's secret mechanism (the homelab uses Sealed Secrets). Never
   commit plaintext.

```bash
CLIENT_SECRET="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 64)"
# authentik side (worker env), e.g. via the authentik chart's global.envFrom:
#   SMS_GATEWAY_OIDC_CLIENT_SECRET=$CLIENT_SECRET
# sms-gateway side:
kubectl create secret generic sms-gateway-oidc -n sms-gateway \
  --from-literal=OIDC_CLIENT_SECRET="$CLIENT_SECRET" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
  --dry-run=client -o yaml   # pipe to kubeseal / your secret tooling
```

2. Apply the prod blueprint (see above), or create the provider by hand with the
   same settings as the table above. **Select the signing key**: it is the
   setting most often missed.
3. Do **not** create a shared known-password test user in production.
4. Confirm discovery:

```bash
curl -sS "https://sso.sthuck.info/application/o/sms-gateway/.well-known/openid-configuration" \
  | jq .issuer,.jwks_uri,.id_token_signing_alg_values_supported
# expect the issuer above, a jwks_uri under the same path, and ["RS256"]
```

## Helm env

`secrets.oidcEnabled` stays **false** by default in `values.yaml` so a bare
install does not require OIDC secrets. When enabling, create the
`sms-gateway-oidc` Secret (see above) and set the non-secret config:

```yaml
config:
  OIDC_ISSUER_URL: "https://sso.sthuck.info/application/o/sms-gateway/"
  OIDC_CLIENT_ID: "sms-gateway"
  OIDC_REDIRECT_URI: "https://sms.sthuck.info/v1/auth/callback"
  OIDC_SCOPES: "openid profile email"
  OIDC_AUDIENCE: "sms-gateway"
  OIDC_APPLICATION_SLUG: "sms-gateway"
  REQUIRE_MFA: "true"
  MFA_CLAIMS_MISSING: "deny"
  AUTO_LINK_BY_EMAIL: "false"
  PUBLIC_BASE_URL: "https://sms.sthuck.info"
  CORS_ALLOWED_ORIGINS: "https://sms.sthuck.info"

secrets:
  oidcEnabled: true
  oidcSecretName: sms-gateway-oidc
  oidcClientSecretKey: OIDC_CLIENT_SECRET
  sessionSecretKey: SESSION_SECRET
```

Do not set `OIDC_ALLOW_INSECURE` outside local HTTP IdPs.

## Cloudflare Access / Zero-Trust Tunnel (STH-60)

When exposing the API behind Cloudflare Access (for example via `cloudflared`),
human browser logins still use OIDC interactive auth, while non-interactive
clients (paired Android devices and PAT agent scripts) need Cloudflare Access
service token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

### Environment variables & precedence

| Scope | Env vars | Used by |
| --- | --- | --- |
| Shared fallback | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Both devices and agents unless overridden |
| Device override | `DEVICE_CF_ACCESS_CLIENT_ID`, `DEVICE_CF_ACCESS_CLIENT_SECRET` | `POST /v1/pairing-codes` (`qr_payload` `&headers=…`) |
| Agent override | `AGENT_CF_ACCESS_CLIENT_ID`, `AGENT_CF_ACCESS_CLIENT_SECRET` | `POST /v1/tokens` (`access_headers`) |

- Precedence: `deviceHeaders = deviceOverride ?? shared`; `agentHeaders = agentOverride ?? shared`.
- Leaving the shared pair unset and configuring only one override provisions
  headers for that client type only.
- Startup (`loadConfig`) fails fast if only one half (`*_ID` or `*_SECRET`) of
  any pair is set, or if header values fail validation (printable ASCII, no
  leading/trailing whitespace).
- In Helm (`deploy/helm/sms-gateway/`), set `secrets.cfAccessEnabled: true` and
  populate `sms-gateway-cf-access` with the shared and/or scoped keys.

### Proxy, `Host` header, and `TRUST_PROXY`

- **`TRUST_PROXY`:** Set `config.TRUST_PROXY` to the `cloudflared` (or Ingress)
  pod/node CIDR (e.g. `"10.42.0.0/16"`) so Fastify `request.ip` resolves the
  real client IP for pairing rate limits and audit logs rather than the tunnel
  pod IP.
- **`Host` header preservation:** Configure `cloudflared` / Ingress to preserve
  the external `Host` header (`sms.sthuck.info`), and ensure
  `DEVICE_ALLOWED_HOSTS` (or derived `PUBLIC_BASE_URL` /
  `DEVICE_API_PUBLIC_URL`) includes `sms.sthuck.info` so ES256 device signatures
  verify against the canonical `HOST` field.

### Service token rotation runbook (re-pair flow)

Because paired Android devices store their service token credentials locally
after scanning the pairing QR/URI, rotating the device service token requires
re-pairing devices:

1. Create a **new** Cloudflare Access service token and allow **both** the old
   and new service tokens in the Access policy during cutover.
2. Update the backend secret (`DEVICE_CF_ACCESS_CLIENT_ID` /
   `DEVICE_CF_ACCESS_CLIENT_SECRET`, or shared `CF_ACCESS_*`) and roll the API
   Deployment.
3. For each active Android device: issue a fresh pairing code in the Web UI
   (`/devices/pair`), scan the QR code (or open the copied pairing URI) on the
   device to provision the new tunnel headers, and revoke the superseded device
   entry if a new device record was created.
4. Once all devices and agent scripts have migrated to the new credentials,
   remove/revoke the old Cloudflare Access service token from the Access policy.
