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

Use the same slug (`sms-gateway`) in Authentik, the local blueprint under
`deploy/authentik/blueprints/`, and Helm `config.OIDC_APPLICATION_SLUG`.

Local Compose still uses `http://127.0.0.1:9000/application/o/sms-gateway/` —
see `docs/local-dev.md`. The blueprint registers **both** prod and localhost
redirect URIs.

## Authentik application (when deploying)

1. Create an **OAuth2/OpenID Provider** + **Application** (or import
   `deploy/authentik/blueprints/sms-gateway-oidc.yaml`):
   - Application slug: **`sms-gateway`**
   - Client type: confidential
   - Redirect URIs:
     - `https://sms.sthuck.info/v1/auth/callback`
     - `http://127.0.0.1:8080/v1/auth/callback`
     - `http://localhost:8080/v1/auth/callback`
     - `http://localhost:5173/v1/auth/callback` (optional Vite)
   - Scopes: `openid profile email`
   - MFA on the authentication flow
2. Confirm discovery:

```bash
curl -sS "https://auth.sthuck.info/application/o/sms-gateway/.well-known/openid-configuration" \
  | jq .issuer,.jwks_uri
```

## Helm env (examples only for now)

`secrets.oidcEnabled` stays **false** by default in `values.yaml` so a bare
install does not require OIDC secrets. When enabling later, create a Secret
(do not commit real values):

```bash
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'
```

Then set non-secret config (also commented in `values.yaml`):

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
