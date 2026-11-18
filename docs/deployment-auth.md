# Deploying Authentik and wiring OIDC

Authentik is **not** part of the `sms-gateway` Helm chart. Install it with the
[official Authentik Helm chart](https://docs.goauthentik.io/docs/installation/kubernetes/),
then point the SMS Gateway API at the issuer and client credentials.

## Authentik (homelab Kubernetes)

1. Install Authentik (Postgres + Redis + server + worker) into a dedicated
   namespace, e.g. `authentik`.
2. Create an **OAuth2/OpenID Provider** and **Application**:
   - Client type: confidential
   - Redirect URI: `https://<sms-gateway-api-host>/v1/auth/callback`
   - Scopes: `openid profile email`
   - Enable MFA (TOTP / WebAuthn) on the authentication flow used by this app
3. Note the issuer URL (typically `https://<authentik-host>/application/o/<slug>/`),
   client id, and client secret.
4. Confirm discovery works:

```bash
curl -sS "$ISSUER/.well-known/openid-configuration" | jq .issuer,.jwks_uri
```

## Wire env into `deploy/helm/sms-gateway`

Create a Secret (example — do not commit real values):

```bash
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'
```

In values (non-secret pieces in `config`, secrets referenced under `secrets`):

```yaml
config:
  NODE_ENV: production
  OIDC_ISSUER_URL: "https://authentik.example/application/o/sms-gateway/"
  OIDC_CLIENT_ID: "sms-gateway"
  OIDC_REDIRECT_URI: "https://api.sms-gateway.example/v1/auth/callback"
  OIDC_SCOPES: "openid profile email"
  OIDC_AUDIENCE: "sms-gateway"
  REQUIRE_MFA: "true"
  MFA_CLAIMS_MISSING: "deny"
  AUTO_LINK_BY_EMAIL: "false"
  PUBLIC_BASE_URL: "https://app.sms-gateway.example/"

secrets:
  oidcSecretName: sms-gateway-oidc
  oidcClientSecretKey: OIDC_CLIENT_SECRET
  sessionSecretKey: SESSION_SECRET
```

`REQUIRE_MFA` should stay true in production. Do not set
`OIDC_ALLOW_INSECURE` outside local HTTP IdPs.

## Checklist

- [ ] Authentik MFA enrolment required before app access
- [ ] Redirect URI matches the API ingress exactly
- [ ] `sms-gateway` Secret contains client secret + session secret
- [ ] API pods roll out with the new ConfigMap/Secret refs
- [ ] `GET /v1/auth/login` redirects to Authentik
