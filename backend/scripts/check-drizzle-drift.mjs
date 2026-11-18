#!/usr/bin/env node
/**
 * CI guards:
 * 1. `drizzle-kit generate` must print "No schema changes, nothing to migrate"
 *    (schema.ts ↔ snapshot). Fail on malformed meta JSON, unexpected output,
 *    non-zero exit, or any new migration/meta files.
 * 2. journal `when` values must strictly increase (drizzle-orm#5769).
 * 3. No `drizzle-kit push` / migrate push script exposure (repo-wide).
 *
 * Also supports:
 *   node scripts/check-drizzle-drift.mjs --assert-detects-drift <drizzleDir> <schemaTs>
 *     Run generate against a (mutated) drizzle tree + schema; exit 0 only if
 *     real schema drift is detected (new 0001_*.sql after a loaded schema).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(backendRoot);
const drizzleDir = path.join(backendRoot, "drizzle");
const metaDir = path.join(drizzleDir, "meta");
const journalPath = path.join(metaDir, "_journal.json");
const packageJsonPath = path.join(backendRoot, "package.json");
const defaultSchemaPath = path.join(backendRoot, "src/adapters/db-postgres/schema.ts");
const defaultOwnedTablesPath = path.join(backendRoot, "src/adapters/db-postgres/owned-tables.json");
const kitBin = path.join(backendRoot, "node_modules/.bin/drizzle-kit");

/** Resolve drizzle-kit from backend (pnpm may hoist to the workspace root). */
const requireFromBackend = createRequire(path.join(backendRoot, "package.json"));
const drizzleKitEntryHref = pathToFileURL(requireFromBackend.resolve("drizzle-kit")).href;

const NO_CHANGES_RE = /No schema changes, nothing to migrate/i;
const MALFORMED_RE = /\bmalformed\b/i;
/** drizzle-kit prints this when it writes a new migration SQL file. */
const MIGRATION_FILE_RE = /Your SQL migration file\s+➜\s+\S*0001_\S+\.sql/i;
const TABLES_LOADED_RE = /\b([1-9]\d*)\s+tables\b/i;
const NEW_MIGRATION_SQL_RE = /^0001_.+\.sql$/;

/**
 * Exact trimmed lines that may mention `drizzle-kit push` (forbid docs only).
 * Substring matches like "push guard" / "no push script" are intentionally NOT
 * accepted — `drizzle-kit push # push guard` must fail the guard.
 */
const ALLOWED_PUSH_DOC_LINES = new Set([
  "* Never use `drizzle-kit push`.",
  "* Never use `drizzle-kit push`. Apply via `pnpm migrate:up` only.",
  "* Drizzle Kit config. NEVER use `drizzle-kit push` — only generate + migrate",
  "- **Never** `drizzle-kit push`",
  "- **Never** `drizzle-kit push` (no push script; CI greps for it). Apply only via",
  "**Never** run `drizzle-kit push` — only `generate` (authors) and `pnpm migrate:up` (apply).",
  "CI fails if a `push` script or non-doc `drizzle-kit push` usage appears.",
  "restore a backup. Never use `drizzle-kit push` (CI guards against exposing it).",
  "# Existing legacy DBs: pnpm migrate:stamp (no DDL re-run). Never drizzle-kit push.",
  'it("package.json has no drizzle-kit push script", () => {',
]);

/** Paths whose content may contain an allowlisted forbid-doc line. */
const ALLOWED_PUSH_DOC_PATHS = new Set([
  path.join("backend", "README.md"),
  path.join("backend", "drizzle", "README.md"),
  path.join("backend", "drizzle.config.ts"),
  path.join("backend", "scripts", "migrate.mjs"),
  path.join("backend", "src", "adapters", "db-postgres", "schema.ts"),
  path.join("backend", "test", "db", "migrations.test.ts"),
  path.join("docs", "local-dev.md"),
  path.join("docs", "schema.md"),
  path.join("docker-compose.yml"),
]);

const assertDetectsDrift = process.argv[2] === "--assert-detects-drift";

if (assertDetectsDrift) {
  const probeDrizzleDir = process.argv[3];
  const probeSchema = process.argv[4] ?? defaultSchemaPath;
  if (!probeDrizzleDir) {
    console.error("Usage: check-drizzle-drift.mjs --assert-detects-drift <drizzleDir> [schemaTs]");
    process.exit(2);
  }
  const detected = runGenerateExpectingDrift(probeDrizzleDir, probeSchema);
  if (!detected) {
    console.error(
      "Negative drift test failed: generate did not produce a real 0001_*.sql migration against the mutated tree",
    );
    process.exit(1);
  }
  console.log("Negative drift test OK (generate detected schema changes).");
  process.exit(0);
}

let failed = false;

function fail(msg) {
  console.error(msg);
  failed = true;
}

// --- journal when strictly increasing ---
{
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = journal.entries ?? [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1].when;
    const cur = entries[i].when;
    if (!(typeof cur === "number" && typeof prev === "number" && cur > prev)) {
      fail(
        `drizzle/meta/_journal.json: entry[${i}].when (${cur}) must be > entry[${i - 1}].when (${prev}) (drizzle-orm#5769)`,
      );
    }
  }
  console.log(
    `Journal when monotonic OK (${entries.length} entr${entries.length === 1 ? "y" : "ies"}).`,
  );
}

// --- no push script / usage (repo-wide) ---
{
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const [name, value] of Object.entries(pkg.scripts ?? {})) {
    if (/\bpush\b/i.test(name) || /drizzle-kit\s+push/.test(String(value))) {
      fail(`Forbidden push script in package.json: "${name}": "${value}"`);
    }
  }

  /**
   * @param {string} line
   * @param {string} rel
   */
  function isAllowlistedForbidDoc(line, rel) {
    if (rel === path.join("backend", "scripts", "check-drizzle-drift.mjs")) return true;
    const trimmed = line.trim();
    if (!ALLOWED_PUSH_DOC_PATHS.has(rel)) return false;
    return ALLOWED_PUSH_DOC_LINES.has(trimmed);
  }

  const pushHits = [];
  walk(repoRoot, (file) => {
    if (!/\.(mjs|js|cjs|ts|tsx|json|md|yml|yaml)$/.test(file)) return;
    const rel = path.relative(repoRoot, file);
    if (
      rel.startsWith("node_modules/") ||
      rel.includes(`${path.sep}node_modules${path.sep}`) ||
      rel.startsWith(`backend${path.sep}dist${path.sep}`) ||
      rel.startsWith(`.git${path.sep}`) ||
      rel.includes(`${path.sep}.drift-probe-`)
    ) {
      return;
    }
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/drizzle-kit\s+push/.test(line)) continue;
      if (isAllowlistedForbidDoc(line, rel)) continue;
      pushHits.push(`${rel}:${i + 1}:${line.trim()}`);
    }
  });
  for (const hit of pushHits) {
    fail(`Forbidden drizzle-kit push usage: ${hit}`);
  }
  console.log("No drizzle-kit push script/usage OK.");
}

// --- drizzle-kit generate must be an explicit no-op (on a temp copy) ---
{
  for (const f of fs.readdirSync(metaDir)) {
    if (!f.endsWith(".json")) continue;
    if (f === "_journal.json") continue;
    if (!/^\d+_snapshot\.json$/.test(f)) {
      fail(
        `drizzle/meta/${f} is not a numbered snapshot — drizzle-kit will treat it as malformed and silently skip generate. Move it out of meta/.`,
      );
    }
  }

  const probe = withTempDrizzleTree(defaultSchemaPath, (drizzleCopy, schemaCopy) =>
    runGenerate(drizzleCopy, schemaCopy),
  );

  if (probe.exitCode !== 0) {
    fail(`drizzle-kit generate exited ${probe.exitCode}:\n${probe.combined}`);
  } else if (MALFORMED_RE.test(probe.combined)) {
    fail(`drizzle-kit generate reported malformed meta JSON:\n${probe.combined}`);
  } else if (!NO_CHANGES_RE.test(probe.combined)) {
    fail(
      `drizzle-kit generate did not print "No schema changes, nothing to migrate". Output:\n${probe.combined}`,
    );
  } else if (probe.newSql.length > 0 || probe.newMeta.length > 0 || probe.journalMutated) {
    fail(
      `drizzle-kit generate produced artifacts despite no-op claim: sql=${probe.newSql.join(",")} meta=${probe.newMeta.join(",")}`,
    );
  } else {
    console.log('drizzle-kit generate no-op OK ("No schema changes, nothing to migrate").');
  }
}

/**
 * Copy drizzle/ + schema into a temp dir under backendRoot (drizzle-kit resolves
 * `out` as cwd-relative and breaks on absolute /tmp paths), run fn, then delete.
 * @template T
 * @param {string} schemaPath
 * @param {(drizzleCopy: string, schemaCopy: string) => T} fn
 * @returns {T}
 */
function withTempDrizzleTree(schemaPath, fn) {
  const tmp = fs.mkdtempSync(path.join(backendRoot, ".drift-probe-"));
  try {
    const drizzleCopy = path.join(tmp, "drizzle");
    const schemaDir = path.join(tmp, "schema");
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.cpSync(drizzleDir, drizzleCopy, { recursive: true });
    const schemaCopy = path.join(schemaDir, "schema.ts");
    fs.copyFileSync(schemaPath, schemaCopy);
    // schema.ts imports ./owned-tables.json — keep it next to the copy.
    const ownedSrc =
      path.dirname(schemaPath) === path.dirname(defaultSchemaPath)
        ? defaultOwnedTablesPath
        : path.join(path.dirname(schemaPath), "owned-tables.json");
    if (fs.existsSync(ownedSrc)) {
      fs.copyFileSync(ownedSrc, path.join(schemaDir, "owned-tables.json"));
    }
    return fn(drizzleCopy, schemaCopy);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} targetDrizzleDir
 * @param {string} schemaPath
 */
function runGenerate(targetDrizzleDir, schemaPath) {
  const targetMeta = path.join(targetDrizzleDir, "meta");
  const targetJournal = path.join(targetMeta, "_journal.json");
  const beforeSql = new Set(fs.readdirSync(targetDrizzleDir).filter((f) => f.endsWith(".sql")));
  const beforeMeta = new Set(fs.readdirSync(targetMeta));
  const journalBackup = fs.readFileSync(targetJournal, "utf8");

  const tmpName = `ci-drift-probe-${process.pid}`;
  // Always write a probe config that imports drizzle-kit via absolute file URL
  // (temp dirs cannot resolve the package by bare specifier).
  const cleanupConfigDir = fs.mkdtempSync(path.join(backendRoot, ".drift-cfg-"));
  const configPath = path.join(cleanupConfigDir, "drizzle.config.ts");
  // drizzle-kit joins `out` as `./${out}` — keep paths relative to backendRoot.
  const outRel = toBackendRel(targetDrizzleDir);
  const schemaRel = toBackendRel(schemaPath);
  fs.writeFileSync(
    configPath,
    `import { defineConfig } from ${JSON.stringify(drizzleKitEntryHref)};\n` +
      `export default defineConfig({\n` +
      `  schema: ${JSON.stringify(schemaRel)},\n` +
      `  out: ${JSON.stringify(outRel)},\n` +
      `  dialect: "postgresql",\n` +
      `  schemaFilter: ["public", "app"],\n` +
      `});\n`,
  );

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(kitBin, ["generate", "--config", configPath, "--name", tmpName], {
      cwd: backendRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    exitCode = typeof err.status === "number" ? err.status : 1;
    stdout = String(err.stdout ?? "");
    stderr = String(err.stderr ?? "");
  } finally {
    fs.rmSync(cleanupConfigDir, { recursive: true, force: true });
  }

  const afterSql = fs.readdirSync(targetDrizzleDir).filter((f) => f.endsWith(".sql"));
  const afterMeta = fs.readdirSync(targetMeta);
  const afterJournal = fs.readFileSync(targetJournal, "utf8");

  return {
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    exitCode,
    newSql: afterSql.filter((f) => !beforeSql.has(f)),
    newMeta: afterMeta.filter((f) => !beforeMeta.has(f)),
    journalMutated: afterJournal !== journalBackup,
    journalBackup,
  };
}

/** @param {string} abs */
function toBackendRel(abs) {
  const rel = path.relative(backendRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `drizzle-kit probe paths must live under backend/ (got ${abs}). Use a temp copy under backendRoot.`,
    );
  }
  return rel.split(path.sep).join("/");
}

function cleanupArtifacts(targetDrizzleDir, result) {
  for (const f of result.newSql) {
    try {
      fs.unlinkSync(path.join(targetDrizzleDir, f));
    } catch {
      /* ignore */
    }
  }
  for (const f of result.newMeta) {
    try {
      fs.unlinkSync(path.join(targetDrizzleDir, "meta", f));
    } catch {
      /* ignore */
    }
  }
  if (result.journalBackup) {
    fs.writeFileSync(path.join(targetDrizzleDir, "meta", "_journal.json"), result.journalBackup);
  }
}

/**
 * Real drift only: schema loaded (≥1 table) and drizzle-kit wrote 0001_*.sql
 * (or printed its migration-file line). Errors, empty schemas, and no-ops are
 * not drift.
 * @param {string} targetDrizzleDir
 * @param {string} schemaPath
 * @returns {boolean}
 */
function runGenerateExpectingDrift(targetDrizzleDir, schemaPath) {
  // Probe trees must live under backendRoot so drizzle-kit's ./out join works.
  const absDrizzle = path.resolve(targetDrizzleDir);
  const absSchema = path.resolve(schemaPath);
  if (
    !absDrizzle.startsWith(backendRoot + path.sep) ||
    !absSchema.startsWith(backendRoot + path.sep)
  ) {
    // Copy into a backend-local temp tree, then evaluate.
    const schemaDir = path.dirname(absSchema);
    const owned = path.join(schemaDir, "owned-tables.json");
    const tmp = fs.mkdtempSync(path.join(backendRoot, ".drift-probe-"));
    try {
      const drizzleCopy = path.join(tmp, "drizzle");
      const schemaCopyDir = path.join(tmp, "schema");
      fs.mkdirSync(schemaCopyDir, { recursive: true });
      fs.cpSync(absDrizzle, drizzleCopy, { recursive: true });
      const schemaCopy = path.join(schemaCopyDir, "schema.ts");
      fs.copyFileSync(absSchema, schemaCopy);
      if (fs.existsSync(owned)) {
        fs.copyFileSync(owned, path.join(schemaCopyDir, "owned-tables.json"));
      }
      return runGenerateExpectingDrift(drizzleCopy, schemaCopy);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const result = runGenerate(targetDrizzleDir, schemaPath);
  const hasNewMigrationSql = result.newSql.some((f) => NEW_MIGRATION_SQL_RE.test(f));
  const tablesLoaded = TABLES_LOADED_RE.test(result.combined);
  const driftMessage = MIGRATION_FILE_RE.test(result.combined);
  const detected = tablesLoaded && (hasNewMigrationSql || driftMessage);

  cleanupArtifacts(targetDrizzleDir, result);
  return detected;
}

function walk(dir, onFile) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ent.name === "node_modules" ||
      ent.name === "dist" ||
      ent.name === ".git" ||
      ent.name.startsWith(".drift-probe-") ||
      ent.name.startsWith(".drift-cfg-")
    ) {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

if (failed) {
  process.exit(1);
}
console.log("Drizzle drift checks passed.");
