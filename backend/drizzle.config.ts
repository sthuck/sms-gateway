import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config. NEVER use `drizzle-kit push` — only generate + migrate
 * via `scripts/migrate.mjs` (or `drizzle-kit generate` when authoring).
 *
 * `schemaFilter` excludes `pgboss` (installed by bootstrap-pgboss.mjs) so
 * pull/introspect do not try to manage queue tables.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/db-postgres/schema.ts",
  out: "./drizzle",
  schemaFilter: ["public", "app"],
  migrations: {
    table: "__drizzle_migrations",
    schema: "drizzle",
  },
  dbCredentials: {
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
  entities: {
    // sms_app is pgRole(...).existing(); do not let kit invent role DDL.
    roles: {
      exclude: ["sms_app"],
    },
  },
});
