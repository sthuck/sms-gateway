#!/usr/bin/env node
/**
 * CI guards:
 * 1. `drizzle-kit generate` must be a no-op (schema.ts ↔ snapshot).
 * 2. journal `when` values must strictly increase (drizzle-orm#5769).
 * 3. No `drizzle-kit push` / migrate push script exposure.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const drizzleDir = path.join(backendRoot, "drizzle");
const metaDir = path.join(drizzleDir, "meta");
const journalPath = path.join(metaDir, "_journal.json");
const packageJsonPath = path.join(backendRoot, "package.json");

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

// --- no push script / usage ---
{
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const [name, value] of Object.entries(pkg.scripts ?? {})) {
    if (/\bpush\b/i.test(name) || /drizzle-kit\s+push/.test(String(value))) {
      fail(`Forbidden push script in package.json: "${name}": "${value}"`);
    }
  }

  const pushHits = [];
  walk(backendRoot, (file) => {
    if (!/\.(mjs|js|ts|json|md|yml|yaml)$/.test(file)) return;
    const rel = path.relative(backendRoot, file);
    if (rel.startsWith("node_modules/") || rel.startsWith("dist/")) return;
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/drizzle-kit\s+push/.test(line)) continue;
      // Permit docs/comments/guards that forbid push (not actual kit invocations).
      if (
        /never|do not|don't|forbidden|not use|only generate|Never|no `?drizzle-kit push|fails if|push guard|No drizzle-kit push|has no drizzle-kit push/i.test(
          line,
        )
      ) {
        continue;
      }
      if (rel === "scripts/check-drizzle-drift.mjs") continue;
      pushHits.push(`${rel}:${i + 1}:${line.trim()}`);
    }
  });
  for (const hit of pushHits) {
    fail(`Forbidden drizzle-kit push usage: ${hit}`);
  }
  console.log("No drizzle-kit push script/usage OK.");
}

// --- drizzle-kit generate is a no-op ---
{
  const beforeSql = new Set(fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")));
  const beforeMeta = new Set(fs.readdirSync(metaDir));
  const beforeJournal = fs.readFileSync(journalPath, "utf8");

  const tmpName = `ci-drift-probe-${process.pid}`;
  let generateOut = "";
  try {
    generateOut = execFileSync("pnpm", ["exec", "drizzle-kit", "generate", "--name", tmpName], {
      cwd: backendRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fail(`drizzle-kit generate failed:\n${err.stdout ?? ""}\n${err.stderr ?? err.message}`);
  }

  const afterSql = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
  const afterMeta = fs.readdirSync(metaDir);
  const afterJournal = fs.readFileSync(journalPath, "utf8");

  for (const f of afterSql) {
    if (!beforeSql.has(f)) {
      fs.unlinkSync(path.join(drizzleDir, f));
      fail(`drizzle-kit generate produced new migration ${f} — snapshot is stale vs schema.ts`);
    }
  }
  for (const f of afterMeta) {
    if (!beforeMeta.has(f)) {
      fs.unlinkSync(path.join(metaDir, f));
      fail(`drizzle-kit generate produced new meta file ${f}`);
    }
  }
  if (afterJournal !== beforeJournal) {
    fs.writeFileSync(journalPath, beforeJournal);
    fail("drizzle-kit generate mutated _journal.json — snapshot drift");
  }

  if (
    /No schema changes, nothing to migrate/i.test(generateOut) ||
    generateOut.includes("nothing to migrate")
  ) {
    console.log("drizzle-kit generate no-op OK.");
  } else if (!failed) {
    console.log("drizzle-kit generate produced no new files OK.");
  }
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
