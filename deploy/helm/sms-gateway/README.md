# sms-gateway Helm chart

Deploys SMS Gateway as three Deployments that share one container image with
different commands (the API Deployment serves both `/v1/*` and the bundled Web
UI SPA on port 8080 behind the single `/` Ingress):

| Component | Command | Service |
| --- | --- | --- |
| API + Web UI | `node dist/index.js` | ClusterIP (default port 8080) |
| Worker | `node dist/worker.js` | none |
| MCP | `node dist/mcp.js` | ClusterIP (default port 8081) |

## Install

```bash
# Create secrets first (examples — do not commit real values)
kubectl create secret generic sms-gateway-database \
  --from-literal=DATABASE_URL='postgres://user:pass@postgres:5432/sms'
# 32-byte KEK file (STH-20). Mounted at /var/run/secrets/sms-gateway/kek
dd if=/dev/urandom bs=32 count=1 of=/tmp/kek
kubectl create secret generic sms-gateway-encryption \
  --from-file=kek=/tmp/kek
rm -f /tmp/kek
kubectl create secret generic sms-gateway-llm \
  --from-literal=LLM_API_KEY='replace-me'
# OIDC (when secrets.oidcEnabled=true) — see docs/deployment-auth.md
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'

helm upgrade --install sms-gateway ./deploy/helm/sms-gateway \
  --set image.repository=ghcr.io/sthuck/sms-gateway-backend \
  --set image.tag=latest \
  --set config.LLM_BASE_URL=https://llm.example/v1 \
  --set config.LLM_MODEL=classifier
```

Validate locally:

```bash
helm lint deploy/helm/sms-gateway
helm template sms-gateway deploy/helm/sms-gateway >/dev/null
```

## Configuration

See `values.yaml`. Notable knobs:

- `config.*` — non-secret env (`HOST`, `PORT`, `LOG_LEVEL`, `WEB_DIST_DIR`, `LLM_*`, `OIDC_*`, MFA, CORS)
- `config.WEB_DIST_DIR` — path to built `web/dist` served by the API on the same origin (default `/app/web-dist`; set `""` to run API-only)
- `config.OIDC_APPLICATION_SLUG` — Authentik app slug (`sms-gateway`); issuer path segment
- `config.CORS_ALLOWED_ORIGINS` — comma-separated browser origins
- `secrets.*` — Secret names/keys for `DATABASE_URL`, KEK file, `LLM_API_KEY`, OIDC
- `secrets.oidcEnabled` — default **false**; set true when wiring OIDC secrets
- `config.ENCRYPTION_ENABLED` / `KEK_FILE` / `KEK_ID` — body encryption (STH-20)
- `ingress.enabled` — optional Ingress for the API Service
- `api` / `worker` / `mcp` — replicas, resources, commands

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

The chart mounts a **32-byte KEK file** from Secret
`secrets.encryptionKekSecretName` (key `encryptionKekSecretKey`, default
`kek`) at `config.KEK_FILE` (default `/var/run/secrets/sms-gateway/kek`).
Set `ENCRYPTION_ENABLED=true` (default in values). Rotation and crypto-shred
are documented in `docs/encryption.md`. A Vault/cloud-KMS adapter is future
work behind the same `KeyWrapper` port — do not bake keys into chart values.
