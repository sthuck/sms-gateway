# Deploying Authentik and wiring OIDC

Authentik is **not** part of the `sms-gateway` Helm chart. Install it with the
[official Authentik Helm chart](https://docs.goauthentik.io/docs/installation/kubernetes/),
then point the SMS Gateway API at the issuer and client credentials.

## Homelab hostnames (sthuck)

| Role | URL |
| --- | --- |
| App / API | `https://sms.sthuck.info` |
| Authentik | `https://auth.sthuck.info` |
| Authentik application **slug** | `sms-gateway` |
| OIDC issuer | `https://auth.sthuck.info/application/o/sms-gateway/` |
| Redirect URI | `https://sms.sthuck.info/v1/auth/callback` |
| CORS origin | `https://sms.sthuck.info` |

Use the same slug (`sms-gateway`) in Authentik, the blueprint under
`deploy/authentik/blueprints/`, and Helm `config.OIDC_APPLICATION_SLUG`.

## Authentik (homelab Kubernetes)

1. Install Authentik (Postgres + Redis + server + worker) into a dedicated
   namespace, e.g. `authentik`, reachable at `https://auth.sthuck.info`.
2. Create an **OAuth2/OpenID Provider** and **Application** (or import
   `deploy/authentik/blueprints/sms-gateway-oidc.yaml`):
   - Application slug: **`sms-gateway`**
   - Client type: confidential
   - Client ID: `sms-gateway` (homelab); local Compose may use `sms-gateway-dev`
   - Redirect URIs (register **all** that you use):
     - `https://sms.sthuck.info/v1/auth/callback` (production)
     - `http://127.0.0.1:8080/v1/auth/callback` (local API)
     - `http://localhost:8080/v1/auth/callback`
     - `http://localhost:5173/v1/auth/callback` (web Vite, optional)
   - Scopes: `openid profile email`
   - Enable MFA (TOTP / WebAuthn) on the authentication flow used by this app
3. Issuer URL:

```text
https://auth.sthuck.info/application/o/sms-gateway/
```

4. Confirm discovery works:

```bash
curl -sS "https://auth.sthuck.info/application/o/sms-gateway/.well-known/openid-configuration" \
  | jq .issuer,.jwks_uri
```

## Wire env into `deploy/helm/sms-gateway`

Create a Secret (example — do not commit real values):

```bash
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'
```

### Homelab values overlay

Base `values.yaml` keeps `secrets.oidcEnabled: false` so a bare install does
not require OIDC secrets. Homelab production uses
`values-homelab.yaml`, which sets the real hostnames and enables OIDC:

```bash
helm upgrade --install sms-gateway ./deploy/helm/sms-gateway \
  -f deploy/helm/sms-gateway/values-homelab.yaml \
  --set image.repository=ghcr.io/sthuck/sms-gateway-backend \
  --set image.tag=<tag>
```

That overlay sets (non-secret):

| Key | Value |
| --- | --- |
| `config.OIDC_ISSUER_URL` | `https://auth.sthuck.info/application/o/sms-gateway/` |
| `config.OIDC_CLIENT_ID` | `sms-gateway` |
| `config.OIDC_REDIRECT_URI` | `https://sms.sthuck.info/v1/auth/callback` |
| `config.PUBLIC_BASE_URL` | `https://sms.sthuck.info` |
| `config.CORS_ALLOWED_ORIGINS` | `https://sms.sthuck.info` |
| `config.REQUIRE_MFA` | `true` |
| `secrets.oidcEnabled` | `true` |
| `ingress.enabled` | `true` |
| `ingress.hosts[0].host` | `sms.sthuck.info` |
| `ingress.tls[0].secretName` | `sms-sthuck-info-tls` |

TLS: set `ingress.annotations` (e.g. cert-manager cluster-issuer) and/or the
TLS secret name to match your cluster. The chart does not assume a particular
cert issuer.

`REQUIRE_MFA` should stay true in production. Do not set
`OIDC_ALLOW_INSECURE` outside local HTTP IdPs.

## Checklist

- [ ] Authentik MFA enrolment required before app access
- [ ] Application slug is `sms-gateway`; issuer matches discovery
- [ ] Prod + localhost redirect URIs registered in Authentik
- [ ] `sms-gateway-oidc` Secret contains client secret + session secret
- [ ] Deployed with `-f values-homelab.yaml` (or equivalent)
- [ ] Ingress host `sms.sthuck.info` + TLS secret/annotations configured
- [ ] `GET https://sms.sthuck.info/v1/auth/login` redirects to Authentik
