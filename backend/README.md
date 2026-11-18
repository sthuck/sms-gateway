# Backend (`@sms-gateway/backend`)

Fastify API, pg-boss worker, and MCP stub.

## Layout (ports & adapters)

User-auth is packaged by layer (`domain` / `application` / `ports` /
`adapters` / `composition`). Pairing, device auth, and queue remain under
`src/device` and `src/queue` until PR B2. Details:
`docs/architecture-layers.md`.

```bash
pnpm lint:arch   # dependency-cruiser: domain/application stay framework-free
```

## Database

- **Schema:** `src/adapters/db-postgres/schema.ts` (Drizzle ORM 0.45.x)
- **Migrations:** `drizzle/` — apply with `pnpm migrate:up`
- **Legacy CJS history:** `migrations-legacy/` (do not run for fresh DBs)
- **Never** `drizzle-kit push`

See `drizzle/README.md` and `docs/schema.md`.

```bash
export MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms
export SMS_APP_PASSWORD=sms_app
pnpm migrate:up
# existing legacy DB:
pnpm migrate:stamp
```
