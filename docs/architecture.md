# Architecture

SMS Gateway forwards SMS from an Android device to a backend. Users see
only their own messages and define **streams** (rule- or AI-filtered
views). AI agents read streams via REST or an MCP server with scoped
auth.

## Proposed stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Language / runtime | TypeScript on Node.js | Strict TypeScript throughout |
| HTTP API | Fastify | OpenAPI-first; contract under `docs/contracts/` |
| Database | PostgreSQL | Row-level security for owner isolation — see `docs/schema.md` (STH-8) |
| Queue | pg-boss | Postgres-backed; no separate broker |
| Web UI | React | Placeholder under `web/` |
| Agent interface | Official MCP TypeScript SDK | Separate process / Deployment |
| Packaging | pnpm workspaces | Monorepo: `backend/`, `web/`, `android/` |
| Deploy | Helm on Kubernetes | Chart under `deploy/helm/sms-gateway/` |

Decisions:

- User auth IdP: **Authentik** via generic OIDC (STH-9) — see
  `docs/adr/0001-oidc-authentik.md` and `docs/deployment-auth.md`

Still open (see also Linear STH-6 / architecture canvas):

- Message-body encryption key / KMS secret handling (see below)

## Monorepo layout

```
android/          # Android client (placeholder)
backend/          # API, worker, and MCP entrypoints (one image, three processes)
web/              # React UI (placeholder)
deploy/helm/      # Kubernetes Helm charts
docs/             # Architecture, local-dev, API contracts
```

## Homelab Kubernetes: Postgres and the queue

Postgres and the queue run in the same homelab Kubernetes cluster as the
application. They are deployed with Helm (application chart under
`deploy/helm/sms-gateway/`; Postgres via a separate chart or operator).

### Queue (pg-boss)

pg-boss stores jobs in Postgres tables in the **same** database the API
uses. There is no Redis, RabbitMQ, or other queue infrastructure to
operate. The `worker` Deployment runs the pg-boss consumer process
against `DATABASE_URL`.

### Postgres options

Either of these is acceptable for the homelab:

1. **In-cluster StatefulSet** — a simple Postgres StatefulSet with a PVC
   for data, plus a backup CronJob or volume-snapshot policy.
2. **CloudNativePG operator** — a `Cluster` custom resource managed by
   [CloudNativePG](https://cloudnative-pg.io/), with PVC-backed storage
   and the operator’s built-in backup/WAL archival to an object store.

The application Helm chart does **not** bundle Postgres by default.
Point `DATABASE_URL` (and related secret refs) at whichever option you
run. See `deploy/helm/sms-gateway/README.md`.

### Encryption key / KMS (open item)

Message bodies are expected to be encrypted at rest. How the encryption
key is stored and rotated — Kubernetes Secret, external KMS, sealed
secrets, or a secrets operator — is an **open item**. Until that is
decided, charts only reference a placeholder secret key name
(`encryptionKeySecret`) and do not generate keys.
