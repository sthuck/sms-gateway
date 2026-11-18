# Postgres schema and RLS

Companion to Linear **STH-8**. The live source of truth is
`backend/migrations/`; this document explains the model, roles, and
isolation pattern.

Message bodies are stored as `body_ciphertext` (`bytea`). Columns hold
ciphertext only; envelope encryption / KMS wrapping is a later ticket
(STH-20). **Never log message bodies, pairing codes, or signatures.**

## ER diagram

```mermaid
erDiagram
  users ||--o{ user_identities : identities
  users ||--o{ sessions : sessions
  users ||--o{ devices : owns
  users ||--o{ pairing_codes : issues
  users ||--o{ messages : owns
  users ||--o{ streams : owns
  users ||--o{ agent_clients : owns
  users ||--o{ audit_log : owns
  users ||--o{ sender_ai_optout : owns
  devices ||--|| device_credentials : has
  devices ||--o{ messages : uploads
  streams ||--o{ stream_membership : matches
  messages ||--o{ stream_membership : member_of
  agent_clients ||--o{ agent_grants : granted
  streams ||--o{ agent_grants : scoped_to

  users {
    uuid id PK
    uuid owner_id "equals id"
    text email
    bool mfa_enrolled
    text encryption_key_ref
    timestamptz created_at
  }

  user_identities {
    uuid id PK
    uuid owner_id FK
    text issuer
    text sub
  }

  sessions {
    uuid id PK
    uuid owner_id FK
    text session_id_hash
    text csrf_token_hash
    timestamptz expires_at
    timestamptz revoked_at
  }

  devices {
    uuid id PK
    uuid owner_id FK
    text name
    jsonb platform_info
    timestamptz last_seen_at
    device_status status
  }

  device_credentials {
    uuid id PK
    uuid owner_id FK
    uuid device_id FK
    text public_key "ES256 SPKI base64url"
    timestamptz revoked_at
  }

  pairing_codes {
    uuid id PK
    uuid owner_id FK
    text code_hash
    timestamptz expires_at
    timestamptz used_at
  }

  messages {
    uuid id PK
    uuid owner_id FK
    uuid device_id FK
    varchar device_msg_id
    varchar sender
    bytea body_ciphertext
    timestamptz received_at
    int sim_slot
    message_direction direction
  }

  streams {
    uuid id PK
    uuid owner_id FK
    text name
    stream_mode mode
    jsonb rules_json
    text ai_prompt
    int version
    stream_backfill_status backfill_status
  }

  stream_membership {
    uuid stream_id PK_FK
    uuid message_id PK_FK
    uuid owner_id FK
    matched_by matched_by
    real confidence
    int stream_version
  }

  agent_clients {
    uuid id PK
    uuid owner_id FK
    text name
    agent_client_kind kind
    text key_hash
    text key_prefix
    text client_id
    text[] redirect_uris
  }

  agent_grants {
    uuid id PK
    uuid owner_id FK
    uuid agent_client_id FK
    uuid stream_id FK
    text[] scopes
  }

  audit_log {
    uuid id PK
    uuid owner_id FK
    audit_actor_type actor_type
    uuid actor_id
    text action
    uuid stream_id
    int message_count
    inet ip
    timestamptz at
  }

  sender_ai_optout {
    uuid id PK
    uuid owner_id FK
    text sender_pattern
  }
```

## Tables

| Table | Notes |
| --- | --- |
| `users` | `owner_id` equals `id` (CHECK + BEFORE INSERT trigger). Not keyed by a single IdP subject. |
| `user_identities` | Maps `(issuer, sub)` → `users.id`, UNIQUE `(issuer, sub)`. Lets Authentik / generic OIDC stay switchable (STH-9). |
| `sessions` | Web UI server-side sessions (STH-9). Store only `session_id_hash` / `csrf_token_hash`; revoke on logout. |
| `devices` | `status`: `active` \| `revoked`. |
| `device_credentials` | One active credential row per device; ES256 SPKI public key per `docs/contracts/device-signing.md`. |
| `pairing_codes` | Short-lived, single-use. **Store only `code_hash`**, never the plaintext code. |
| `messages` | UNIQUE `(device_id, device_msg_id)` (idempotency). `device_msg_id` ≤ 128 chars. |
| `streams` | `mode`: `rules` \| `ai` \| `hybrid`. |
| `stream_membership` | Composite PK `(stream_id, message_id)`; `owner_id` denormalised for RLS. |
| `agent_clients` | `api_key` (hash + prefix) or `oauth` (`client_id` + redirect URIs). |
| `agent_grants` | Scopes default `stream:read`. |
| `audit_log` | Actor is `user` \| `device` \| `agent`. |
| `sender_ai_optout` | Per-owner sender patterns excluded from AI classification. |

Every owned table carries `owner_id` so RLS is a single predicate. Foreign
keys use `ON DELETE CASCADE` from `users` (and along device / stream /
client edges) so a hard delete of a user’s data is possible.
`audit_log.stream_id` is `ON DELETE SET NULL` so history can outlive a
stream row when desired.

## Roles

| Role | Purpose |
| --- | --- |
| **Migrator** (`sms` in local Compose / CI) | Owns tables, runs `node-pg-migrate`. Connect with `MIGRATE_DATABASE_URL`. May be a superuser locally; production should be a non-superuser table owner with rights to create objects. |
| **`sms_app`** | Application / worker / MCP. `LOGIN`, **no** `BYPASSRLS`, **no** superuser. Connect with `DATABASE_URL`. |

### `sms_app` password

- `SMS_APP_PASSWORD` is **required** for `migrate:up` (no hardcoded default in
  `scripts/migrate.mjs`). Missing → fail fast.
- On first create only, migrate sets the role password via a parameterized
  `ALTER ROLE` (never interpolated into migration SQL logs).
- Later `migrate:up` runs **do not** reset the password.
- To rotate: run manually as the migrator role —

```sql
ALTER ROLE sms_app PASSWORD '<new-secret>';
```

Secrets: put `DATABASE_URL`, `MIGRATE_DATABASE_URL`, and `SMS_APP_PASSWORD`
in the environment or a secret store — never commit them. Compose / CI /
`.env.example` use the labelled **local-dev-only** value `sms_app`.

```bash
# Migrate (privileged) — SMS_APP_PASSWORD required
MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms \
SMS_APP_PASSWORD=sms_app \
  pnpm --filter @sms-gateway/backend migrate:up

# App (RLS-enforced)
DATABASE_URL=postgres://sms_app:sms_app@localhost:5432/sms
```

## RLS

- `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` on every
  owned table.
- Policy `owner_isolation` for role `sms_app`:
  `USING (owner_id = app.current_owner_id())`
  `WITH CHECK (owner_id = app.current_owner_id())`.
- `app.current_owner_id()` reads `current_setting('app.owner_id', true)`.
  Missing, empty, or invalid values yield `NULL` → **zero rows**, never an
  error that could leak existence and never a bypass.

### Request-scoped helper

`withOwner(pool, ownerId, fn)` (see `backend/src/db/with-owner.ts`) opens a
transaction, runs `SELECT set_config('app.owner_id', $1, true)` (third
argument `true` = transaction-local), then invokes `fn`. No global session
state leaks between pooled requests.

## Device and pairing lookups (pre-owner)

Device ingestion and pairing authenticate by device id or pairing code
**before** `app.owner_id` is known. The app role must not use `BYPASSRLS`.

Narrow `SECURITY DEFINER` functions (owned by the migrator, `search_path`
pinned, `EXECUTE` granted only to `sms_app`):

| Function | Use |
| --- | --- |
| `app.lookup_device_for_auth(device_id)` | Returns `owner_id`, status, public key for signature verify. |
| `app.lookup_pairing_code(code_hash)` | Returns `owner_id` for a non-expired, unused code. |
| `app.lookup_user_identity(issuer, sub)` | Returns `owner_id` for an OIDC identity (STH-9). |
| `app.lookup_session(session_id_hash)` | Returns session owner / CSRF hash / expiry (STH-9). |
| `app.lookup_user_by_email(email)` | Optional email auto-link only (`AUTO_LINK_BY_EMAIL`). |

Pattern:

1. Call the lookup function (no `app.owner_id` yet).
2. Verify signature / code as appropriate in application code.
3. Enter `withOwner(ownerId, …)` for all subsequent reads/writes
   (insert device, burn pairing code, upsert messages).

Do not broaden these functions to return message bodies or arbitrary
rows.

## Indexes (selected)

- `messages (owner_id, received_at DESC)`
- `messages (device_id, device_msg_id)` unique
- `stream_membership (stream_id, created_at DESC)`
- `user_identities (issuer, sub)` unique
- `pairing_codes (code_hash)` unique
- `audit_log (owner_id, at DESC)`

## Encryption at rest

`messages.body_ciphertext` stores opaque bytes. Cleartext must not appear
in logs, traces, queue payloads, or error reports. Key handling
(`users.encryption_key_ref`) is implemented in STH-20.
