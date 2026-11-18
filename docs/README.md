# Documentation

| Doc | Description |
| --- | --- |
| [architecture.md](./architecture.md) | Proposed stack and homelab Kubernetes notes |
| [schema.md](./schema.md) | Postgres ER diagram, RLS, roles, device/pairing lookups |
| [local-dev.md](./local-dev.md) | Docker Compose, ports, emulator access, Prism mock |
| [contracts/device-api.yaml](./contracts/device-api.yaml) | STH-5 device API OpenAPI contract (v1 draft 2) |
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
