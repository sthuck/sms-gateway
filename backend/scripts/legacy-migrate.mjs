#!/usr/bin/env node
/**
 * Test/CI-only: apply legacy node-pg-migrate CJS files from migrations-legacy/.
 * Production and normal local-dev use scripts/migrate.mjs (Drizzle) instead.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const direction = process.argv[2] ?? "up";

const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set MIGRATE_DATABASE_URL or DATABASE_URL for legacy migrations.");
  process.exit(1);
}

const args = [
  "node-pg-migrate",
  "-m",
  "migrations-legacy",
  "--ignore-pattern",
  ".*(README|\\.gitkeep).*",
  direction,
  ...process.argv.slice(3),
];

const child = spawn("pnpm", ["exec", ...args], {
  cwd: backendRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
