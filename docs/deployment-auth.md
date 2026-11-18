# Deploying Authentik and wiring OIDC

Homelab Kubernetes deploy of Authentik + Ingress/TLS is **deferred** to the
end of the project. This note records the agreed hostnames and how OIDC env
is wired into `deploy/helm/sms-gateway` when that work resumes.

Authentik is **not** part of the `sms-gateway` Helm chart. Install it with the
[official Authentik Helm chart](https://docs.goauthentik.io/docs/installation/kubernetes/)
when ready, then point the API at the issuer and client credentials.

## Agreed hostnames (sthuck)

| Role | URL |
| --- | --- |
| App / API | `https://sms.sthuck.info` |
| Authentik | `https://auth.sthuck.info` |
| Authentik application **slug** | `sms-gateway` |
| OIDC issuer | `https://auth.sthuck.info/application/o/sms-gateway/` |
| Redirect URI (prod) | `https://sms.sthuck.info/v1/auth/callback` |
| CORS origin (prod) | `https://sms.sthuck.info` |

Use the same slug (`sms-gateway`) in Authentik, Helm
`config.OIDC_APPLICATION_SLUG`, and the **prod** blueprint template.

Local Compose uses `http://127.0.0.1:9000/application/o/sms-gateway/` — see
`docs/local-dev.md` and the **dev** blueprint only.

## Blueprints (dev vs prod)

| File | Use | Redirects | Secrets / users |
| --- | --- | --- | --- |
| `deploy/authentik/blueprints/sms-gateway-oidc-dev.yaml` | Local Compose only | localhost / 127.0.0.1 | DEV-ONLY via Compose `!Env`; seeded `sms-dev` |
| `deploy/authentik/blueprints/sms-gateway-oidc-prod.yaml` | Homelab / production | `https://sms.sthuck.info/v1/auth/callback` only | Client id/secret from env (`!Env`); **no** seeded user |

**Never** import the dev blueprint into production Authentik. Dev-only
passwords and client secrets must not be reused outside local Compose.

## Authentik application (production / homelab)

1. Prefer creating the OAuth2 provider in the Authentik UI and generating a
   fresh client secret there, **or** import
   `sms-gateway-oidc-prod.yaml` with env set (no defaults for secrets):

```bash
export AUTHENTIK_SMS_GATEWAY_CLIENT_ID=sms-gateway
export AUTHENTIK_SMS_GATEWAY_CLIENT_SECRET="$(openssl rand -base64 32)"
# Then import the prod blueprint in Authentik (System → Blueprints).
# Store the same secret in k8s — never commit it:
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET="$AUTHENTIK_SMS_GATEWAY_CLIENT_SECRET" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)"
```

Manual steps if blueprint import is unavailable:

1. Create an **OAuth2/OpenID Provider** + **Application**:
   - Application slug: **`sms-gateway`**
   - Client type: confidential
   - Client ID: choose (e.g. `sms-gateway`); generate secret in Authentik
   - Redirect URI: **only** `https://sms.sthuck.info/v1/auth/callback`
   - Scopes: `openid profile email`
   - MFA on the authentication flow
2. Do **not** create a shared known-password test user in production.
3. Confirm discovery:

```bash
curl -sS "https://auth.sthuck.info/application/o/sms-gateway/.well-known/openid-configuration" \
  | jq .issuer,.jwks_uri
```

## Helm env (examples only for now)

`secrets.oidcEnabled` stays **false** by default in `values.yaml` so a bare
install does not require OIDC secrets. When enabling later, create the
`sms-gateway-oidc` Secret out-of-band (see above) and set non-secret config
(also commented in `values.yaml`):

```yaml
config:
  OIDC_ISSUER_URL: "https://auth.sthuck.info/application/o/sms-gateway/"
  OIDC_CLIENT_ID: "sms-gateway"
  OIDC_REDIRECT_URI: "https://sms.sthuck.info/v1/auth/callback"
  OIDC_SCOPES: "openid profile email"
  OIDC_AUDIENCE: "sms-gateway"
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
