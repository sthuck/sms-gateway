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

Homelab hosts: app `https://sms.sthuck.info`, Authentik
`https://sso.sthuck.info` (slug `sms-gateway`). Both need certificates the
clients trust. The app host must be **publicly** trusted, because the Android
app trusts system CAs only. See [deployment-auth.md](./deployment-auth.md#tls-requirements).

## 2. Build and push the image

`backend/Dockerfile` builds the Web UI in a `web-build` stage (`pnpm --filter
@sms-gateway/web build`) and copies `web/dist` into `/app/web-dist` in the
runtime image (`ENV WEB_DIST_DIR=/app/web-dist`).

### GitHub Releases → GHCR (automated)

[`.github/workflows/docker-release.yml`](../.github/workflows/docker-release.yml)
builds `backend/Dockerfile` (`linux/amd64`) and publishes to
`ghcr.io/sthuck/sms-gateway-backend` using `GITHUB_TOKEN` when:

- A **GitHub Release is published** (`release: [published]`) via the GitHub UI
  or local `gh release create`, or
- **Docker Release** is triggered manually (`workflow_dispatch`, with an
  optional custom `tag` input).

Tags published on release: the exact release tag (e.g. `v0.1.0`), semver tags
(`0.1.0`, `0.1` for non-prereleases), `sha-<short>`, and `latest` (for
non-prerelease releases). Optional repository variables (Settings → Secrets and
variables → Actions → Variables) `VITE_APK_DOWNLOAD_URL` and
`VITE_CSRF_COOKIE_NAME` are passed as Docker build args (both default empty).

Note: Releases auto-created by `android-release.yml` using `GITHUB_TOKEN` on
`git push origin v*` do **not** trigger `release: [published]` workflows in
GitHub Actions — publish the Release from the GitHub UI / local `gh`, or run
**Docker Release** via `workflow_dispatch`.

### Manual local build & push (fallback)

From the **repo root**:

```bash
# GHCR login (private package)
echo <github-token> | docker login ghcr.io -u <github-user> --password-stdin

docker build -f backend/Dockerfile \
  --build-arg VITE_APK_DOWNLOAD_URL="<apk-release-or-install-url>" \
  -t ghcr.io/sthuck/sms-gateway-backend:<sha> .
docker push ghcr.io/sthuck/sms-gateway-backend:<sha>
```

(`VITE_APK_DOWNLOAD_URL` and `VITE_CSRF_COOKIE_NAME` are optional build args and
default to `""`.) For a
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

## 3. Migrations

`scripts/migrate.mjs up` applies pending Drizzle migrations, creates role
`sms_app` (`LOGIN`, **no** `BYPASSRLS`) if missing, sets its password **only on
first create** from `SMS_APP_PASSWORD`, then bootstraps pg-boss. Runtime API and
worker pods use `DATABASE_URL` as `sms_app` (RLS). Details:
[schema.md](./schema.md), [queue.md](./queue.md).

### Database roles

- **Migrator** (`MIGRATE_DATABASE_URL`, migrate Job only): must **own** the
  `sms` database and have **`CREATEROLE` and `BYPASSRLS`** (or be superuser).
  `BYPASSRLS` is required because the pre-owner `SECURITY DEFINER` lookups run as
  this role under `FORCE ROW LEVEL SECURITY`. Without it they return nothing and
  login breaks (see [schema.md](./schema.md#device-and-pairing-lookups-pre-owner)).
  `0000_baseline` creates `sms_app` and `migrate.mjs` sets its password. On
  PostgreSQL 16+ a `CREATEROLE` role gets `ADMIN OPTION` on the roles it creates,
  which is what allows that `ALTER ROLE`.
- **Do not pre-create `sms_app`**: its password is set only when the migration
  creates it.
- **Never point `DATABASE_URL` at the migrator**: as table owner it bypasses the
  `FORCE ROW LEVEL SECURITY` policies.

### TLS to Postgres (`sslmode`)

The backend uses `pg` with `pg-connection-string` 2.x, where `sslmode=require`
means **verify-full**, not libpq's "encrypt, don't verify". Against a server with
a self-signed or cluster-internal certificate (e.g. CloudNativePG), either:

- add `uselibpqcompat=true` for libpq semantics:
  `postgres://sms_app:<pw>@<host>:5432/sms?sslmode=require&uselibpqcompat=true`
  (the homelab uses this for both URLs), or
- verify properly with `sslrootcert=<ca file>` (mount it with the chart's
  `extraVolumes` / `extraVolumeMounts`).

### Option A — In-cluster Helm hook Job (recommended)

`backend/Dockerfile` bundles `drizzle/` and `scripts/`, and the chart provides
an opt-in `pre-install,pre-upgrade` hook Job (`migrations.enabled: true`) so
migrations finish before API/worker pods start, without exposing migrator
credentials to runtime Deployments:

```bash
kubectl create secret generic sms-gateway-migrate \
  --from-literal=MIGRATE_DATABASE_URL='postgres://<migrator>:<password>@<pg-host>:5432/sms' \
  --from-literal=SMS_APP_PASSWORD='<sms-app-password>' \
  -n <ns>
```

Set `migrations.enabled: true` in `my-values.yaml` (Section 5) before running
`helm upgrade --install`.

**Under ArgoCD** the hook becomes a **PreSync** hook, and PreSync runs *before*
ordinary resources are applied. If the Secrets are managed in the same
Application (e.g. as SealedSecrets), a first install deadlocks: the Job waits
for Secrets that are only created after it finishes. Create the Secrets first,
in a separate sync, then enable the workloads.

### Option B — Manual from a laptop

Run against the cluster Postgres from a machine that can reach it:

```bash
export MIGRATE_DATABASE_URL='postgres://<migrator>:<password>@<host>:5432/sms'
export SMS_APP_PASSWORD='<sms-app-password>'   # required; no script default
pnpm --filter @sms-gateway/backend migrate:up
# or: cd backend && pnpm migrate:up
```

Put the same `sms_app` password into the k8s `DATABASE_URL` secret below.
Rotating an existing `sms_app` password is a manual `ALTER ROLE`, not part of
`migrate:up`.

## 4. Secrets

Create these **before** pods become Ready. Names/keys match
`deploy/helm/sms-gateway/values.yaml` defaults.

```bash
# DATABASE_URL for sms_app (RLS) — not the migrator role
kubectl create secret generic sms-gateway-database \
  --from-literal=DATABASE_URL='postgres://sms_app:<password>@<pg-host>:5432/sms' \
  -n <ns>

# 32-byte KEK file → key "kek", mounted under /var/run/secrets/sms-gateway/
# (mode 0440; all keys in this Secret mount so kek-previous can be added for
# KEK_PREVIOUS rotation — see docs/encryption.md)
dd if=/dev/urandom bs=32 count=1 of=/tmp/kek
kubectl create secret generic sms-gateway-encryption \
  --from-file=kek=/tmp/kek \
  -n <ns>
rm -f /tmp/kek

# Optional — LLM key (only required when secrets.llmEnabled=true)
# kubectl create secret generic sms-gateway-llm \
#   --from-literal=LLM_API_KEY='<llm-api-key>' \
#   -n <ns>

# OIDC (required when secrets.oidcEnabled=true; mounted on api only)
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='<authentik-client-secret>' \
  --from-literal=SESSION_SECRET='<32+-random-bytes>' \
  -n <ns>
```

**Warning:** losing the KEK makes encrypted message bodies unrecoverable.

## 5. Helm values and install

Publishing a GitHub Release also packages and pushes the Helm chart to GHCR via
[`.github/workflows/helm-release.yml`](../.github/workflows/helm-release.yml) as
`oci://ghcr.io/sthuck/charts/sms-gateway` (with `--version <tag-without-v>` and
`--app-version <tag>`, matching the published container image tag so `image.tag`
can stay `""`).

Example override for `sms.sthuck.info` / `sso.sthuck.info` (keys from
`values.yaml`; also in [deployment-auth.md](./deployment-auth.md)):

```yaml
# my-values.yaml
image:
  repository: ghcr.io/sthuck/sms-gateway-backend
  # Optional when installing matching OCI chart version (defaults to Chart appVersion):
  # tag: "v0.2.2"

# Only if the GHCR packages are private (they are public):
# imagePullSecrets:
#   - name: ghcr-pull

config:
  WEB_DIST_DIR: "/app/web-dist" # chart default; set "" to run API-only
  TRUST_PROXY: "10.42.0.0/16" # Ingress controller pod CIDR (or hop count "1")
  DEVICE_ALLOWED_HOSTS: "sms.sthuck.info"
  DEVICE_API_PUBLIC_URL: "https://sms.sthuck.info"
  INGEST_DEFAULT_PHONE_REGION: "IL" # or your 2-letter region for national senders
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
  ENCRYPTION_ENABLED: "true"
  KEK_ID: "kek-1"
  KEK_FILE: "/var/run/secrets/sms-gateway/kek"

secrets:
  oidcEnabled: true

ingress:
  enabled: true
  className: "<your-ingress-class>"
  annotations:
    # Must issue a PUBLICLY trusted cert (e.g. Let's Encrypt): the Android app
    # trusts system CAs only. ACME DNS-01 works for LAN-only hosts.
    cert-manager.io/cluster-issuer: "<your-public-issuer>"
    # For nginx Ingress, allow max-size 1 MiB SMS batches:
    # nginx.ingress.kubernetes.io/proxy-body-size: "2m"
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

Install from the published GHCR OCI chart (or pass `./deploy/helm/sms-gateway`
with `--set image.tag=<tag>` when installing from a local checkout):

```bash
echo <github-token> | helm registry login ghcr.io -u <github-user> --password-stdin

helm upgrade --install sms-gateway oci://ghcr.io/sthuck/charts/sms-gateway \
  --version <chart-version> \
  -f my-values.yaml \
  -n <ns>
```

Note: ensure your Ingress controller preserves the external `Host` header
(`sms.sthuck.info`), which the API checks during ES256 device-signature verification.

## 6. Web UI (single-host static serving)

The API Deployment serves the bundled `web/dist` SPA on the same origin
(`https://sms.sthuck.info`) via `config.WEB_DIST_DIR: "/app/web-dist"` (the
chart default, matching `/app/web-dist` baked into `backend/Dockerfile`). The
chart's single `/` Ingress therefore handles both SPA routes (`/`, `/login`,
`/inbox`, `/devices`, `/tokens`, `/assets/*`) and `/v1/*` API calls with
same-origin `sms_session` and `sms_csrf` cookies — no separate nginx Deployment
or Ingress path split is required.

Static-serving behavior on the API:

- Unknown `/v1/*` routes and missing `/assets/*` or extensioned files always
  return `404 application/problem+json` (never HTML).
- `/assets/*` files are served with `Cache-Control: public, max-age=31536000, immutable`.
- HTML (`index.html` and SPA fallback routes) is served with
  `Cache-Control: no-cache`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
- To disable bundled UI serving (for example, if serving `web/dist` externally),
  set `config.WEB_DIST_DIR: ""` in your Helm values — the API Deployment
  explicitly exports `WEB_DIST_DIR` so `""` overrides the Dockerfile default.

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

For device signing Host checks and accurate rate-limit/audit IPs in
production, set `config.DEVICE_ALLOWED_HOSTS`, `config.DEVICE_API_PUBLIC_URL`,
and `config.TRUST_PROXY` in your Helm values (shown in Section 5).

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

## 9. Deployment status & remaining work

All homelab Kubernetes deployment gaps tracked here (bundled single-host UI,
GHCR image & OCI chart release workflows, production `TRUST_PROXY` /
`DEVICE_*` / `INGEST_*` Helm knobs, `NOTES.txt`, graceful shutdown / DB `/readyz`,
and optional `pre-install,pre-upgrade` migration hook Job) are wired. Remaining
feature work (MCP server implementation and stream rule/AI worker handlers) is
tracked separately.
