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
 *     drift is detected (negative test helper).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(backendRoot);
const drizzleDir = path.join(backendRoot, "drizzle");
const metaDir = path.join(drizzleDir, "meta");
const journalPath = path.join(metaDir, "_journal.json");
const packageJsonPath = path.join(backendRoot, "package.json");
const defaultSchemaPath = path.join(backendRoot, "src/adapters/db-postgres/schema.ts");
const kitBin = path.join(backendRoot, "node_modules/.bin/drizzle-kit");

const NO_CHANGES_RE = /No schema changes, nothing to migrate/i;
const MALFORMED_RE = /\bmalformed\b/i;

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
      "Negative drift test failed: generate reported no schema changes against a mutated tree",
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

  /** Whole-line docs/comments that forbid push (explicit allowlist). */
  function isAllowlistedForbidDoc(line) {
    const trimmed = line.trim();
    if (
      /^\*\*?Never\*\*?\s+`?drizzle-kit\s+push/i.test(trimmed) ||
      /^-+\s*\*\*?Never\*\*?\s+`?drizzle-kit\s+push/i.test(trimmed) ||
      /^#{1,6}\s+.*Never.*drizzle-kit\s+push/i.test(trimmed) ||
      /^-\s+\*\*Never\*\*\s+`drizzle-kit push`/i.test(trimmed) ||
      /^-\s+\*\*Never\*\*\s+`drizzle-kit push`/i.test(trimmed)
    ) {
      return true;
    }
    if (
      /^\/\/.*\b(Never|never|do not|don't)\b.*drizzle-kit\s+push/i.test(trimmed) ||
      /^\*\s+.*(Never|never|do not|don't)\b.*drizzle-kit\s+push/i.test(trimmed) ||
      /^\/\*\*.*(Never|never).*drizzle-kit\s+push/i.test(trimmed)
    ) {
      return true;
    }
    if (
      /No `?drizzle-kit push`? script/i.test(trimmed) ||
      /has no drizzle-kit push/i.test(trimmed) ||
      /push guard/i.test(trimmed) ||
      /Forbidden drizzle-kit push/i.test(trimmed) ||
      /fails if a .*push script/i.test(trimmed) ||
      /CI fails if a `push`/i.test(trimmed) ||
      /no push script/i.test(trimmed) ||
      /Never use `drizzle-kit push`/i.test(trimmed) ||
      /never use `drizzle-kit push`/i.test(trimmed) ||
      /\*\*Never\*\* run `drizzle-kit push`/i.test(trimmed) ||
      /Never `drizzle-kit push`/i.test(trimmed)
    ) {
      return true;
    }
    return false;
  }

  const pushHits = [];
  walk(repoRoot, (file) => {
    if (!/\.(mjs|js|cjs|ts|tsx|json|md|yml|yaml)$/.test(file)) return;
    const rel = path.relative(repoRoot, file);
    if (
      rel.startsWith("node_modules/") ||
      rel.includes(`${path.sep}node_modules${path.sep}`) ||
      rel.startsWith(`backend${path.sep}dist${path.sep}`) ||
      rel.startsWith(`.git${path.sep}`)
    ) {
      return;
    }
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/drizzle-kit\s+push/.test(line)) continue;
      if (rel === `backend${path.sep}scripts${path.sep}check-drizzle-drift.mjs`) continue;
      if (isAllowlistedForbidDoc(line)) continue;
      pushHits.push(`${rel}:${i + 1}:${line.trim()}`);
    }
  });
  for (const hit of pushHits) {
    fail(`Forbidden drizzle-kit push usage: ${hit}`);
  }
  console.log("No drizzle-kit push script/usage OK.");
}

// --- drizzle-kit generate must be an explicit no-op ---
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

  const result = runGenerate(drizzleDir, defaultSchemaPath);
  if (result.exitCode !== 0) {
    fail(`drizzle-kit generate exited ${result.exitCode}:\n${result.combined}`);
  } else if (MALFORMED_RE.test(result.combined)) {
    fail(`drizzle-kit generate reported malformed meta JSON:\n${result.combined}`);
  } else if (!NO_CHANGES_RE.test(result.combined)) {
    fail(
      `drizzle-kit generate did not print "No schema changes, nothing to migrate". Output:\n${result.combined}`,
    );
  } else if (result.newSql.length > 0 || result.newMeta.length > 0 || result.journalMutated) {
    cleanupArtifacts(drizzleDir, result);
    fail(
      `drizzle-kit generate produced artifacts despite no-op claim: sql=${result.newSql.join(",")} meta=${result.newMeta.join(",")}`,
    );
  } else {
    console.log('drizzle-kit generate no-op OK ("No schema changes, nothing to migrate").');
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
  const useTempConfig =
    path.resolve(targetDrizzleDir) !== path.resolve(drizzleDir) ||
    path.resolve(schemaPath) !== path.resolve(defaultSchemaPath);

  let configPath = path.join(backendRoot, "drizzle.config.ts");
  let cleanupConfigDir = null;
  if (useTempConfig) {
    cleanupConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sms-drizzle-cfg-"));
    configPath = path.join(cleanupConfigDir, "drizzle.config.ts");
    fs.writeFileSync(
      configPath,
      `import { defineConfig } from "drizzle-kit";\n` +
        `export default defineConfig({\n` +
        `  schema: ${JSON.stringify(schemaPath)},\n` +
        `  out: ${JSON.stringify(targetDrizzleDir)},\n` +
        `  dialect: "postgresql",\n` +
        `  schemaFilter: ["public", "app"],\n` +
        `});\n`,
    );
  }

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
    if (cleanupConfigDir) {
      fs.rmSync(cleanupConfigDir, { recursive: true, force: true });
    }
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
 * @param {string} targetDrizzleDir
 * @param {string} schemaPath
 * @returns {boolean}
 */
function runGenerateExpectingDrift(targetDrizzleDir, schemaPath) {
  const result = runGenerate(targetDrizzleDir, schemaPath);
  cleanupArtifacts(targetDrizzleDir, result);

  if (MALFORMED_RE.test(result.combined)) return true;
  if (result.newSql.length > 0 || result.newMeta.length > 0 || result.journalMutated) return true;
  if (result.exitCode !== 0 && !NO_CHANGES_RE.test(result.combined)) return true;
  if (!NO_CHANGES_RE.test(result.combined)) return true;
  return false;
}

function walk(dir, onFile) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

if (failed) {
  process.exit(1);
}
console.log("Drizzle drift checks passed.");
