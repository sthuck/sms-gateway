# Homelab deploy (Kubernetes)

Deploy the SMS Gateway backend to a homelab cluster using only what this repo
ships today. Authentik, Postgres, Ingress, and TLS are external. Chart:
`deploy/helm/sms-gateway`.

## 1. Prerequisites

- Kubernetes cluster with an Ingress controller and cert-manager (or other TLS)
- **Postgres** (external — the chart does **not** bundle it; see
  `deploy/helm/sms-gateway/README.md`)
- **Authentik** installed separately: blueprints under `deploy/authentik/`,
  hostnames and Helm OIDC wiring in [deployment-auth.md](./deployment-auth.md)

Agreed hosts: app `https://sms.sthuck.info`, Authentik
`https://auth.sthuck.info` (slug `sms-gateway`).

## 2. Build and push the image

From the **repo root** (see `backend/Dockerfile`):

```bash
# GHCR login (private package)
echo <github-token> | docker login ghcr.io -u <github-user> --password-stdin

docker build -f backend/Dockerfile -t ghcr.io/sthuck/sms-gateway-backend:<sha> .
docker push ghcr.io/sthuck/sms-gateway-backend:<sha>
```

There is **no** image-publish workflow; CI only builds the image locally. For a
private GHCR package, create a pull secret and wire the chart’s top-level
`imagePullSecrets` (default `[]` in `values.yaml`):

```bash
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<github-token> \
  --docker-email=<email> \
  -n <ns>
```

```yaml
# my-values.yaml
imagePullSecrets:
  - name: ghcr-pull
```

## 3. Migrations (from a laptop)

Run against the cluster Postgres from a machine that can reach it. Script:
`backend` package `migrate:up` (`scripts/migrate.mjs up`). It applies Drizzle
migrations, creates role `sms_app` (`LOGIN`, **no** `BYPASSRLS`) if missing,
sets its password **only on first create** from `SMS_APP_PASSWORD`, then
bootstraps pg-boss. Runtime pods use `DATABASE_URL` as `sms_app` (RLS).

```bash
export MIGRATE_DATABASE_URL='postgres://<migrator>:<password>@<host>:5432/sms'
export SMS_APP_PASSWORD='<sms-app-password>'   # required; no script default
pnpm --filter @sms-gateway/backend migrate:up
# or: cd backend && pnpm migrate:up
```

Put the same app password into the k8s `DATABASE_URL` secret below. Rotating an
existing `sms_app` password is a manual `ALTER ROLE`, not part of `migrate:up`.
Details: [schema.md](./schema.md), [queue.md](./queue.md).

## 4. Secrets

Create these **before** pods become Ready. Names/keys match
`deploy/helm/sms-gateway/values.yaml` defaults.

```bash
# DATABASE_URL for sms_app (RLS) — not the migrator role
kubectl create secret generic sms-gateway-database \
  --from-literal=DATABASE_URL='postgres://sms_app:<password>@<pg-host>:5432/sms' \
  -n <ns>

# 32-byte KEK file → key "kek", mounted at /var/run/secrets/sms-gateway/kek
# (config.KEK_FILE / ENCRYPTION_ENABLED / KEK_ID; see docs/encryption.md)
dd if=/dev/urandom bs=32 count=1 of=/tmp/kek
kubectl create secret generic sms-gateway-encryption \
  --from-file=kek=/tmp/kek \
  -n <ns>
rm -f /tmp/kek

# LLM key (dummy OK until a real classifier is wired)
kubectl create secret generic sms-gateway-llm \
  --from-literal=LLM_API_KEY='dummy' \
  -n <ns>

# OIDC (required when secrets.oidcEnabled=true)
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='<authentik-client-secret>' \
  --from-literal=SESSION_SECRET='<32+-random-bytes>' \
  -n <ns>
```

**Warning:** losing the KEK makes encrypted message bodies unrecoverable.

## 5. Helm values and install

Example override for `sms.sthuck.info` / `auth.sthuck.info` (keys from
`values.yaml`; also in [deployment-auth.md](./deployment-auth.md)):

```yaml
# my-values.yaml
image:
  repository: ghcr.io/sthuck/sms-gateway-backend
  tag: "<sha>"

imagePullSecrets:
  - name: ghcr-pull

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
  ENCRYPTION_ENABLED: "true"
  KEK_ID: "kek-1"
  KEK_FILE: "/var/run/secrets/sms-gateway/kek"

secrets:
  oidcEnabled: true

ingress:
  enabled: true
  className: "<your-ingress-class>"
  annotations:
    cert-manager.io/cluster-issuer: "<your-issuer>"
  hosts:
    - host: sms.sthuck.info
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: sms-gateway-tls
      hosts:
        - sms.sthuck.info
```

```bash
helm upgrade --install sms-gateway deploy/helm/sms-gateway \
  -f my-values.yaml \
  -n <ns>
```

## 6. Web UI (interim)

The chart deploys API / worker / MCP only — it does **not** serve `web/dist`
(tracked as [STH-58](https://linear.app/sthuck/issue/STH-58)). The SPA expects
same-origin `/v1` so session (`sms_session`) and CSRF (`sms_csrf`) cookies work
(`web/README.md`).

Interim:

1. `pnpm web:build` → `web/dist`
2. Serve that tree with nginx (or similar)
3. Route one host so `/v1` → API Service and `/` → the static server

Example Ingress paths (API Service name is `<release>-api`, default
`sms-gateway-api`; adjust the web Service name to match your nginx Deploy):

```yaml
# Idea only — not rendered by the chart today
rules:
  - host: sms.sthuck.info
    http:
      paths:
        - path: /v1
          pathType: Prefix
          backend:
            service:
              name: sms-gateway-api
              port:
                number: 8080
        - path: /
          pathType: Prefix
          backend:
            service:
              name: sms-gateway-web
              port:
                number: 80
```

Until that exists, the chart’s single `/` path sends everything to the API.

## 7. Android release APK

Four GitHub Actions secrets (see [android/releasing.md](./android/releasing.md)):

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Push a `v*` tag (`vMAJOR.MINOR.PATCH`). `.github/workflows/android-release.yml`
builds a signed prod APK and attaches it to a GitHub Release. Install/update
via Obtainium: [android/obtainium.md](./android/obtainium.md),
[android/install.md](./android/install.md).

For device signing Host checks in production, the API also needs
`DEVICE_ALLOWED_HOSTS` / `DEVICE_API_PUBLIC_URL` (and usually `TRUST_PROXY`) —
those env vars exist in the backend but are **not** exposed in the chart yet
(see Known gaps).

## 8. Smoke test

1. Open `https://sms.sthuck.info`, log in via OIDC (Authentik + MFA).
2. Pair a phone (pairing UI / QR).
3. Confirm messages appear in the inbox.
4. Create a PAT on the **Tokens** page (`/tokens`).
5. Call the API:

```bash
curl -sS -H "Authorization: Bearer <pat>" \
  "https://sms.sthuck.info/v1/messages"
```

More PAT usage: [agent-access.md](./agent-access.md).

## 9. Known gaps

Verified against the repo as of this doc:

- `TRUST_PROXY`, `DEVICE_ALLOWED_HOSTS`, and `DEVICE_API_PUBLIC_URL` are read by
  the backend (`.env.example`, pairing/device auth) but **not** present in
  Helm `values.yaml` / `sms-gateway.env`.
- No in-cluster migrate Job — migrations are laptop/`pnpm migrate:up` only.
- No GHCR image publish workflow (CI builds `sms-gateway-backend:ci` only).
- Chart does not serve `web/dist` (STH-58); same-origin SPA needs an interim
  static + path split (section 6).
- `templates/NOTES.txt` references `secrets.encryptionSecretName` /
  `secrets.encryptionSecretKey`, but `values.yaml` defines
  `encryptionKekSecretName` / `encryptionKekSecretKey` — NOTES will render
  empty for the encryption secret line.
