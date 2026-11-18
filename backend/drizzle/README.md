# Drizzle migrations

Tooling: [drizzle-orm](https://orm.drizzle.team/) **0.45.x** + [drizzle-kit](https://orm.drizzle.team/docs/kit-overview).
**Never** run `drizzle-kit push` — only `generate` (authors) and `pnpm migrate:up` (apply).
CI fails if a `push` script or non-doc `drizzle-kit push` usage appears.

```bash
export MIGRATE_DATABASE_URL=postgres://sms:sms@localhost:5432/sms
export SMS_APP_PASSWORD=sms_app   # required for migrate:up; no script default

pnpm migrate:up                   # fresh DB: apply baseline + bootstrap pg-boss
pnpm migrate:stamp                # existing legacy DB: mark baseline applied (no DDL)
pnpm drizzle:check                # snapshot drift + journal when + push guard
```

## Baseline

`0000_baseline.sql` is hand-reviewed. It includes:

- Tables / enums / indexes / `ENABLE ROW LEVEL SECURITY` / `owner_isolation` policies
  (from `src/adapters/db-postgres/schema.ts`).
- **Custom SQL** Drizzle cannot express:
  - `FORCE ROW LEVEL SECURITY` on every `owner_id` table (14)
  - `sms_app` role (`LOGIN … NOBYPASSRLS`; password set only by `migrate.mjs` on first create)
  - `GRANT CONNECT` / schema usage / default privileges
  - `app.current_owner_id()`, trigger `app.users_set_owner_id`
  - `SECURITY DEFINER` lookups + `REVOKE`/`GRANT EXECUTE` + `SET search_path`

`meta/0000_snapshot.json` must stay in sync with `schema.ts` (`pnpm drizzle:check`).
`meta/expected-catalog.json` is the privilege/role/policy fingerprint used by
`migrate:stamp` and catalog equivalence — regenerate with `pnpm catalog:write`
after a clean `migrate:up` when baseline grants/roles change.

## Down migrations

Drizzle has **no** `down`. There is no `migrate:down` script. Roll back by
restoring a backup or recreating the database.

## Legacy history

The former node-pg-migrate CJS files live in `../migrations-legacy/` (git history
only). CI uses them for schema-equivalence and stamp tests via
`scripts/legacy-migrate.mjs`.

## Existing local DB cutover

If you already ran the CJS migrations (`pgmigrations` populated):

```bash
pnpm migrate:stamp    # refuses unless legacy head + catalog match expected baseline
```

Fresh clones: `pnpm migrate:up` only (do not also run the CJS files).
Running `migrate:up` on a legacy DB prints `legacy DB detected: run migrate:stamp`.
