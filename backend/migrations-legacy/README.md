# Legacy node-pg-migrate history

These CJS migrations are **historical**. The live migrator is Drizzle
(`backend/drizzle/` + `scripts/migrate.mjs`).

Do **not** run them for normal local/prod bring-up. Fresh databases use the
Drizzle baseline only.

They remain in git so CI can prove schema equivalence:

1. Apply these via `node scripts/legacy-migrate.mjs up` (test-only).
2. `pnpm migrate:stamp` to mark the Drizzle baseline applied without DDL.
3. Compare `pg_dump --schema-only` to a fresh `pnpm migrate:up`.

See `backend/drizzle/README.md` and `docs/schema.md`.
