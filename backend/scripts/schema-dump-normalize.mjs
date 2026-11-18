#!/usr/bin/env node
/**
 * Normalize `pg_dump --schema-only` output for equivalence comparison.
 *
 * Prefer invoking pg_dump with:
 *   --exclude-schema=pgboss --exclude-schema=drizzle
 * This script still strips migrator tables, comments/owner/set noise, and
 * collapses cosmetic whitespace inside function bodies.
 */
import fs from "node:fs";

const input = fs.readFileSync(0, "utf8");

function normalizeDollarBodies(sql) {
  return sql.replace(/(\$\$)([\s\S]*?)(\$\$)/g, (_m, open, body, close) => {
    const normalized = body
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/^[ \t]+/gm, "")
      .replace(/\n{2,}/g, "\n")
      .trim();
    return `${open}\n${normalized}\n${close}`;
  });
}

/** Drop CREATE/ALTER for public.pgmigrations (legacy migrator bookkeeping). */
function stripPgmigrations(sql) {
  // Remove comment blocks + CREATE TABLE / ALTER / INDEX / SEQUENCE touching pgmigrations.
  return sql
    .replace(/^-- Name: pgmigrations[\s\S]*?(?=^-- Name: |$)/gm, "")
    .replace(/^CREATE TABLE(?: ONLY)? public\.pgmigrations \([\s\S]*?\n\);\n*/gm, "")
    .replace(/^ALTER TABLE(?: ONLY)? public\.pgmigrations[\s\S]*?;\n*/gm, "")
    .replace(/^CREATE SEQUENCE public\.pgmigrations[\s\S]*?;\n*/gm, "")
    .replace(/^ALTER SEQUENCE public\.pgmigrations[\s\S]*?;\n*/gm, "")
    .replace(/^CREATE INDEX[\s\S]*?\bpgmigrations\b[\s\S]*?;\n*/gm, "");
}

let out = input
  .replace(/^--.*$/gm, "")
  .replace(/^\\restrict.*$/gm, "")
  .replace(/^\\unrestrict.*$/gm, "")
  .replace(/^ALTER .* OWNER TO .*;$/gm, "")
  .replace(/^SET .*;$/gm, "")
  .replace(/^SELECT pg_catalog\.set_config.*;$/gm, "");

out = stripPgmigrations(out);

out = out.replace(/ DESC NULLS (FIRST|LAST)/g, " DESC");
out = out.replace(/ ASC NULLS (FIRST|LAST)/g, " ASC");

out = normalizeDollarBodies(out);

out = out
  .replace(/\n{3,}/g, "\n\n")
  .split("\n")
  .map((l) => l.replace(/[ \t]+$/g, ""))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

process.stdout.write(out + "\n");
