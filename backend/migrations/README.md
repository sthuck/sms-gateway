# Database migrations

Tooling: [node-pg-migrate](https://github.com/salsita/node-pg-migrate).

```bash
# Privileged migrator URL (local Compose defaults shown)
export MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms
export DATABASE_URL="$MIGRATE_DATABASE_URL"
# Required for migrate:up (local-dev-only value below). No default in the script.
export SMS_APP_PASSWORD=sms_app

pnpm migrate:create -- <name>
pnpm migrate:up
pnpm migrate:down
```

`SMS_APP_PASSWORD` is applied only when role `sms_app` is first created.
Later ups never reset it — rotate with `ALTER ROLE sms_app PASSWORD '…'`.

Schema, roles (`sms_app`), RLS, and `SECURITY DEFINER` lookup helpers are
defined here (Linear **STH-8**). See `docs/schema.md`.

`migrate:up` also runs `scripts/bootstrap-pgboss.mjs`, which installs the
pg-boss schema (`pgboss`) as the migrator and grants DML to `sms_app`
(Linear **STH-12**). See `docs/queue.md`.
