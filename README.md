# SMS Gateway

Private monorepo for an SMS gateway: an Android app forwards SMS to a backend;
users see only their own messages and define **streams** (rule- or AI-filtered
views). AI agents read streams via REST or an MCP server with scoped auth.

## Layout

```
android/                 # Android client (placeholder README)
backend/                 # Fastify API + worker + MCP stubs (TypeScript)
web/                     # React UI (placeholder README)
deploy/helm/sms-gateway/ # Helm chart (API / worker / MCP Deployments)
docs/                    # Architecture, local-dev, STH-5 contracts
docker-compose.yml       # Postgres + backend (+ optional Prism mock)
.github/workflows/       # Path-filtered CI
```

## Quick start

```bash
# Dependencies (backend)
cd backend && pnpm install && cd ..

# API + Postgres
docker compose up --build
# API: http://localhost:8080  (Android emulator: http://10.0.2.2:8080)

# Optional OpenAPI mock (does not verify signatures)
docker compose --profile mock up mock-api
# Mock: http://localhost:4010 (Android emulator: http://10.0.2.2:4010)

curl -s http://localhost:8080/healthz
```

Local Node (without rebuilding the image):

```bash
cd backend
cp .env.example .env
pnpm dev        # API on 0.0.0.0:8080
pnpm test
pnpm lint
```

Signing test vector (STH-5):

```bash
node docs/contracts/examples/gen-test-vector.mjs
```

## Docs

- [Architecture / stack](docs/architecture.md)
- [Local development](docs/local-dev.md)
- [Docs index](docs/README.md)
- [Device API contract](docs/contracts/device-api.yaml) (STH-5 v1 draft 2)
- [Contract changelog (draft 2)](docs/contracts/CHANGES-draft2.md)
- [Helm chart](deploy/helm/sms-gateway/README.md)

## Stack (proposed)

TypeScript / Node (Fastify), OpenAPI-first, Postgres with RLS, pg-boss
(Postgres-backed queue), React web UI, official MCP TypeScript SDK. Deployed
to a homelab Kubernetes cluster with Helm. Details in `docs/architecture.md`.

## Status

Skeleton only (Linear **STH-6**). No business logic, schema, or auth yet.
Schema/RLS is **STH-8**. The throwaway signing key in
`docs/contracts/examples/` is intentional and labelled — never use it in
production.
