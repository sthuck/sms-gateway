#!/usr/bin/env node
/**
 * Structural guard (STH-46 prevention): forbid catch-all patterns in
 * application + http-fastify that collapse unknown errors into AuthError /
 * unauthorized problem+json without rethrowing InfrastructureError / non-AuthError.
 *
 * Negative proof: pass --fixture to scan test/architecture/fixtures/bad-auth-catch.ts
 * and expect a failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureMode = process.argv.includes("--fixture");

const targets = fixtureMode
  ? [path.join(root, "test/architecture/fixtures/bad-auth-catch.ts")]
  : [path.join(root, "src/adapters/http-fastify"), path.join(root, "src/application")];

/** @type {{ file: string; line: number; text: string }[]} */
const violations = [];

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Bare catch that constructs AuthError / sendProblem unauthorized without
    // an InfrastructureError / AuthError instanceof gate nearby in the same catch.
    if (!/\bcatch\b/.test(line)) continue;
    // Only treat lines that open a catch clause (not comments mentioning catch).
    const catchIdx = line.search(/\bcatch\b/);
    if (catchIdx < 0) continue;
    const afterCatch = line.slice(catchIdx);
    if (!/^catch\s*(\(|\{)/.test(afterCatch) && !/^catch\s*$/.test(afterCatch)) continue;

    // Collect from the catch keyword's opening `{` only (ignore earlier `}` on the line).
    const openAt = line.indexOf("{", catchIdx);
    if (openAt < 0) continue;
    let block = line.slice(catchIdx);
    let depth = 1;
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j += 1;
      block += "\n" + lines[j];
      for (const ch of lines[j]) {
        if (ch === "{") depth += 1;
        if (ch === "}") depth -= 1;
      }
    }

    const collapsesToAuth =
      /new\s+AuthError\s*\(\s*["']unauthorized["']/.test(block) ||
      /sendProblem\s*\([^)]*["']unauthorized["']/.test(block) ||
      /sendProblem\s*\(\s*reply\s*,\s*["']unauthorized["']/.test(block);

    if (!collapsesToAuth) continue;

    const rethrowsNonAuth =
      /throw\s+err/.test(block) ||
      /instanceof\s+InfrastructureError/.test(block) ||
      /isInfrastructureError\s*\(/.test(block) ||
      (/instanceof\s+AuthError/.test(block) && /throw\s+/.test(block));

    // Empty catch `{` that always AuthError — classic STH-46 pattern.
    const bareCatchAll =
      /catch\s*\{/.test(block) ||
      /catch\s*\(\s*_?\s*\)/.test(block) ||
      /catch\s*\(\s*\)/.test(block);

    if (bareCatchAll && collapsesToAuth && !rethrowsNonAuth) {
      violations.push({ file: filePath, line: i + 1, text: lines[i].trim() });
      continue;
    }

    // catch (err) { ... AuthError unauthorized ... } without infra / rethrow gate
    if (collapsesToAuth && !rethrowsNonAuth && !/instanceof\s+AuthError/.test(block)) {
      violations.push({ file: filePath, line: i + 1, text: lines[i].trim() });
    }
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const st = fs.statSync(dir);
  if (st.isFile()) {
    if (dir.endsWith(".ts") || dir.endsWith(".js") || dir.endsWith(".mjs")) scanFile(dir);
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    walk(path.join(dir, name));
  }
}

for (const t of targets) walk(t);

if (fixtureMode) {
  if (violations.length === 0) {
    console.error(
      "check-auth-error-classification: expected fixture bad-auth-catch.ts to violate, but found none",
    );
    process.exit(1);
  }
  console.log(
    `check-auth-error-classification: negative proof OK (${violations.length} violation(s) in fixture)`,
  );
  process.exit(0);
}

if (violations.length > 0) {
  console.error("check-auth-error-classification: forbidden catch→auth collapse:");
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log("check-auth-error-classification: OK");
