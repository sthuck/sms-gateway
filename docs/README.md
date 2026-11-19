# Documentation

| Doc | Description |
| --- | --- |
| [architecture.md](./architecture.md) | Proposed stack and homelab Kubernetes notes |
| [schema.md](./schema.md) | Postgres ER diagram, RLS, roles, device/pairing lookups |
| [queue.md](./queue.md) | pg-boss events, publishInTx, retries/DLQ, worker RLS |
| [local-dev.md](./local-dev.md) | Docker Compose, ports, emulator access, Prism mock, Authentik |
| [pairing.md](./pairing.md) | Pairing codes, device auth, rate limits, replay cache, revoke (STH-14) |
| [android-outbox-retention.md](./android-outbox-retention.md) | Outbox TTL/cap defaults and plaintext-at-rest decision |
| [android-keepalive.md](./android-keepalive.md) | FGS vs WorkManager, boot/Doze/force-stop, permissions, OEM setup (STH-47) |
| [contracts/device-heartbeat-draft.md](./contracts/device-heartbeat-draft.md) | Proposed `POST /v1/devices/me/heartbeat` (backend not shipped yet) |
| [deployment-auth.md](./deployment-auth.md) | OIDC/Authentik hostnames and Helm env examples (deploy deferred) |
| [adr/0001-oidc-authentik.md](./adr/0001-oidc-authentik.md) | ADR: generic OIDC, identity mapping, MFA, sessions |
| [contracts/device-api.yaml](./contracts/device-api.yaml) | STH-5 device API OpenAPI contract (v1 draft 2) |
| [contracts/user-api.yaml](./contracts/user-api.yaml) | User/web auth + owner device/messages/streams/PATs OpenAPI |
| [agent-access.md](./agent-access.md) | Owner PATs for agent/script inbox read access |
| [contracts/device-signing.md](./contracts/device-signing.md) | ECDSA P-256 request signing scheme + test vector |
| [contracts/semantics.md](./contracts/semantics.md) | Idempotency, batch limits, errors, retries |
| [contracts/CHANGES-draft2.md](./contracts/CHANGES-draft2.md) | Changelog from draft 1 → draft 2 (Android review) |
| [contracts/examples/](./contracts/examples/) | Signing test-vector generator and frozen JSON |

## Contracts

The device API contract (STH-5) lives under `docs/contracts/`. Verify the
signing test vector from the repo root:

```bash
node docs/contracts/examples/gen-test-vector.mjs
```

The keypair in the test vector is a **throwaway** — never use it in
production or on a real device.
