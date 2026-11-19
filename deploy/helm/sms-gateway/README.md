# sms-gateway Helm chart

Deploys SMS Gateway from OCI (`oci://ghcr.io/sthuck/charts/sms-gateway`) or
local chart source. By default the API and worker Deployments are enabled (the
API Deployment serves both `/v1/*` and the bundled Web UI SPA on port 8080
behind the single `/` Ingress). The stub MCP Deployment defaults to disabled
(`mcp.enabled: false`).

| Component | Command | Default enabled | Service |
| --- | --- | --- | --- |
| API + Web UI | `node dist/index.js` | `true` | ClusterIP (default port 8080) |
| Worker | `node dist/worker.js` | `true` | none |
| MCP | `node dist/mcp.js` | `false` | ClusterIP (default port 8081) |

## Install

```bash
# Create required Secrets first (examples — do not commit real values)
kubectl create secret generic sms-gateway-database \
  --from-literal=DATABASE_URL='postgres://sms_app:pass@postgres:5432/sms'
# 32-byte KEK file (STH-20). Mounted at /var/run/secrets/sms-gateway/kek
dd if=/dev/urandom bs=32 count=1 of=/tmp/kek
kubectl create secret generic sms-gateway-encryption \
  --from-file=kek=/tmp/kek
rm -f /tmp/kek
# Optional — only when secrets.llmEnabled=true:
# kubectl create secret generic sms-gateway-llm \
#   --from-literal=LLM_API_KEY='replace-me'
# OIDC (when secrets.oidcEnabled=true) — see docs/deployment-auth.md
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'

# Install from GHCR OCI (or pass ./deploy/helm/sms-gateway locally)
echo <github-token> | helm registry login ghcr.io -u <github-user> --password-stdin
helm upgrade --install sms-gateway oci://ghcr.io/sthuck/charts/sms-gateway \
  --version <chart-version> \
  -f my-values.yaml
```

Validate locally:

```bash
helm lint deploy/helm/sms-gateway
helm template sms-gateway deploy/helm/sms-gateway >/dev/null
```

## Configuration

See `values.yaml`. Notable knobs:

- `config.*` — non-secret env split into per-component ConfigMaps (`-api`, `-worker`, `-mcp`, hashed into `checksum/config` pod annotations for automatic rollout on config edits):
  - Web & proxy: `WEB_DIST_DIR` (default `/app/web-dist`; set `""` for API-only), `TRUST_PROXY` (`false`, hop count, or Ingress pod CIDR)
  - Device auth & pairing: `DEVICE_ALLOWED_HOSTS`, `DEVICE_API_PUBLIC_URL`, `DEVICE_ALLOW_DERIVED_HOSTS`
  - Ingestion: `INGEST_DEFAULT_PHONE_REGION`, `INGEST_RATE_LIMIT_*`, `INGEST_MESSAGE_RATE_*`
  - Queue / worker: `QUEUE_SCHEMA`, `QUEUE_RETRY_*`, `QUEUE_POLLING_INTERVAL_SECONDS`, `QUEUE_LOCAL_CONCURRENCY`, `QUEUE_SHUTDOWN_TIMEOUT_MS`, `QUEUE_METRICS_*`
  - OIDC & CORS: `OIDC_*`, `REQUIRE_MFA`, `MFA_CLAIMS_MISSING`, `AUTO_LINK_BY_EMAIL`, `PUBLIC_BASE_URL`, `CORS_ALLOWED_ORIGINS` (`OIDC_*` vars are scoped to `-api` only and omitted when `secrets.oidcEnabled=false`)
- `secrets.*` — scoped per component:
  - `databaseSecretName` (`DATABASE_URL`) — mounted on `api` and `worker`
  - `encryptionKekSecretName` — mounted at `/var/run/secrets/sms-gateway/` (mode `0440`) on `api` and `worker` when `ENCRYPTION_ENABLED != "false"`
  - `oidcEnabled` (default **false**) — mounts `OIDC_CLIENT_SECRET` + `SESSION_SECRET` on `api` only
  - `llmEnabled` (default **false**) — mounts `LLM_API_KEY` on `api` and `worker` when enabled
  - `migrateSecretName` (`MIGRATE_DATABASE_URL`, `SMS_APP_PASSWORD`) — mounted **only** on the hook Job when `migrations.enabled=true`
- `migrations.enabled` — default **false**; set **true** to run `node scripts/migrate.mjs up` as a `pre-install,pre-upgrade` Helm hook Job before API/worker pods start
- `ingress.enabled` — optional Ingress for the API + Web UI Service
- `api` / `worker` / `mcp` — replicas, resources, commands, `terminationGracePeriodSeconds` (`30s` on `api`, `45s` on `worker`), `worker.probes` (`/healthz` & `/readyz` on `QUEUE_METRICS_PORT` when `> 0`), and `worker.metricsService.enabled` (ClusterIP Service for Prometheus scraping; `mcp.enabled` defaults to **false** until MCP transport is implemented)

Homelab hostnames (`sms.sthuck.info` / `auth.sthuck.info`) are documented as
commented examples in `values.yaml` and `docs/deployment-auth.md`. Homelab
Ingress/TLS deploy is deferred. Authentik itself is installed separately.


## Postgres (not bundled)

This chart does **not** install Postgres. Provide `DATABASE_URL` via Secret.

Homelab options (also documented in `docs/architecture.md`):

1. **StatefulSet** — run Postgres in-cluster with a PVC and a backup
   CronJob or volume snapshots.
2. **CloudNativePG** — install the operator, then a `Cluster` CR with PVC
   storage and operator-managed backups/WAL archival.

pg-boss (queue) uses the **same** Postgres database. No Redis or other
broker is required; the worker Deployment is the consumer.

### Encryption KEK (STH-20)

When `config.ENCRYPTION_ENABLED` is not `"false"`, the chart mounts **all keys**
from Secret `secrets.encryptionKekSecretName` (mode `0440`, readable by
`fsGroup: 1001`) at `/var/run/secrets/sms-gateway/` on `api` and `worker`. Keep
the active 32-byte key under `secrets.encryptionKekSecretKey` (default `kek`,
matching `config.KEK_FILE`) and add old key entries (e.g. `kek-previous`) to the
same Secret when using `config.KEK_PREVIOUS` during rotation. Rotation and
crypto-shred are documented in `docs/encryption.md`. A Vault/cloud-KMS adapter is
future work behind the same `KeyWrapper` port — do not bake keys into chart
values.
