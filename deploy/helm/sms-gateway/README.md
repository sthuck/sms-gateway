# sms-gateway Helm chart

Deploys the SMS Gateway backend as three Deployments that share one container
image with different commands:

| Component | Command | Service |
| --- | --- | --- |
| API | `node dist/index.js` | ClusterIP (default port 8080) |
| Worker | `node dist/worker.js` | none |
| MCP | `node dist/mcp.js` | ClusterIP (default port 8081) |

## Install

```bash
# Create secrets first (examples — do not commit real values)
kubectl create secret generic sms-gateway-database \
  --from-literal=DATABASE_URL='postgres://user:pass@postgres:5432/sms'
kubectl create secret generic sms-gateway-encryption \
  --from-literal=ENCRYPTION_KEY='replace-me'
kubectl create secret generic sms-gateway-llm \
  --from-literal=LLM_API_KEY='replace-me'
# OIDC (when secrets.oidcEnabled=true) — see docs/deployment-auth.md
kubectl create secret generic sms-gateway-oidc \
  --from-literal=OIDC_CLIENT_SECRET='replace-me' \
  --from-literal=SESSION_SECRET='replace-with-32+-random-bytes'

# Generic / empty OIDC
helm upgrade --install sms-gateway ./deploy/helm/sms-gateway \
  --set image.repository=ghcr.io/sthuck/sms-gateway-backend \
  --set image.tag=latest \
  --set config.LLM_BASE_URL=https://llm.example/v1 \
  --set config.LLM_MODEL=classifier

# Homelab (sms.sthuck.info + Authentik at auth.sthuck.info)
helm upgrade --install sms-gateway ./deploy/helm/sms-gateway \
  -f deploy/helm/sms-gateway/values-homelab.yaml \
  --set image.repository=ghcr.io/sthuck/sms-gateway-backend \
  --set image.tag=latest
```

Validate locally:

```bash
helm lint deploy/helm/sms-gateway
helm template sms-gateway deploy/helm/sms-gateway >/dev/null
helm template sms-gateway deploy/helm/sms-gateway \
  -f deploy/helm/sms-gateway/values-homelab.yaml >/dev/null
```

## Configuration

See `values.yaml` and the homelab overlay `values-homelab.yaml`. Notable knobs:

- `config.*` — non-secret env (`HOST`, `PORT`, `LOG_LEVEL`, `LLM_*`, `OIDC_*`, MFA, CORS)
- `config.OIDC_APPLICATION_SLUG` — Authentik app slug (`sms-gateway`); issuer path segment
- `config.CORS_ALLOWED_ORIGINS` — comma-separated browser origins
- `secrets.*` — Secret names/keys for `DATABASE_URL`, `ENCRYPTION_KEY`, `LLM_API_KEY`, OIDC
- `secrets.oidcEnabled` — default **false** in `values.yaml`; **true** in `values-homelab.yaml`
- `ingress.*` — host, TLS secret name, optional cert-manager annotations
- `api` / `worker` / `mcp` — replicas, resources, commands

Authentik itself is installed separately; see `docs/deployment-auth.md`.

## Postgres (not bundled)

This chart does **not** install Postgres. Provide `DATABASE_URL` via Secret.

Homelab options (also documented in `docs/architecture.md`):

1. **StatefulSet** — run Postgres in-cluster with a PVC and a backup
   CronJob or volume snapshots.
2. **CloudNativePG** — install the operator, then a `Cluster` CR with PVC
   storage and operator-managed backups/WAL archival.

pg-boss (queue) uses the **same** Postgres database. No Redis or other
broker is required; the worker Deployment is the consumer.

### Encryption key / KMS

`ENCRYPTION_KEY` is referenced from a Secret, but how that key is minted,
stored, and rotated (plain Secret vs external KMS vs sealed secrets) is an
**open item**. Do not bake keys into values or the chart.
