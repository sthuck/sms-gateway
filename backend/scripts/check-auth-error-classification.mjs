#!/usr/bin/env node
/**
 * Structural tripwire for STH-46 / STH-48 class bugs.
 *
 * Scans adapters + application (+ device/routes/queue) for:
 * 1. catch / .catch that collapse failures into AuthError / unauthorized /
 *    4xx auth problems / null without rethrowing InfrastructureError
 * 2. Helpers that sendProblem(unauthorized) for unknown (non-AuthError) errors
 *
 * This is a tripwire, not a proof of soundness — the HTTP fault matrix is the
 * real regression guard. See docs/rca/STH-46-infra-errors-as-auth-failures.md.
 *
 * --fixture: expect violations in test/architecture/fixtures/bad-auth-*.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureMode = process.argv.includes("--fixture");

const targets = fixtureMode
  ? [path.join(root, "test/architecture/fixtures")]
  : [
      path.join(root, "src/adapters"),
      path.join(root, "src/application"),
      path.join(root, "src/composition"),
    ];

/** @type {{ file: string; line: number; text: string; reason: string }[]} */
const violations = [];

function record(filePath, line, text, reason) {
  violations.push({ file: filePath, line, text: text.trim(), reason });
}

function scanFile(filePath) {
  // Skip intentional best-effort / purge helpers that swallow background work.
  if (filePath.endsWith(`${path.sep}replay-cache.ts`)) return;
  if (filePath.endsWith(`${path.sep}rate-limit.ts`)) return;

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  // --- Pass A: catch blocks ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bcatch\b/.test(line)) continue;
    const catchIdx = line.search(/\bcatch\b/);
    if (catchIdx < 0) continue;
    const afterCatch = line.slice(catchIdx);
    if (!/^catch\s*(\(|\{)/.test(afterCatch) && !/^catch\s*$/.test(afterCatch)) continue;

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

    // Flag auth credential collapses. Sync URL-parse → invalid_request is OK.
    // Mapping unknown errors to AuthError / unauthorized without infra rethrow is not.
    const collapses =
      /new\s+AuthError\s*\(/.test(block) ||
      /sendProblem\s*\([^;]*["']unauthorized["']/.test(block) ||
      /sendProblem\s*\([^;]*["']forbidden["']/.test(block) ||
      /status\s*\(\s*401\s*\)/.test(block) ||
      /status\s*\(\s*403\s*\)/.test(block);

    const rethrowsInfra =
      /throw\s+err\b/.test(block) ||
      /instanceof\s+InfrastructureError/.test(block) ||
      /isInfrastructureError\s*\(/.test(block) ||
      /isOidcTokenInfrastructureFailure\s*\(/.test(block) ||
      /isJwtInfraFailure\s*\(/.test(block);

    if (collapses && !rethrowsInfra) {
      record(filePath, i + 1, lines[i], "catch collapses to auth/4xx without infra rethrow");
    }
  }

  // --- Pass B: .catch(() => null|undefined) swallow (excluding documented best-effort touch) ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\.catch\s*\(/.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/last_seen|touchSession|best-effort|maybePurge|purgeExpired/i.test(window)) continue;
    if (/\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(line)) {
      record(filePath, i + 1, line, ".catch(() => null) swallows errors");
    }
  }

  // --- Pass C: mapAuthError-style helper — 401 for unknown non-AuthError ---
  // Anti-pattern (STH-46): AuthError branch returns, then fallthrough sendProblem(unauthorized)
  // without `throw err` / InfrastructureError check.
  for (let i = 0; i < lines.length; i++) {
    if (
      !/function\s+\w*[Mm]ap\w*Auth\w*\s*\(/.test(lines[i]) &&
      !/instanceof\s+AuthError/.test(lines[i])
    ) {
      continue;
    }
    const slice = lines.slice(i, Math.min(lines.length, i + 40)).join("\n");
    const fallthrough =
      /instanceof\s+AuthError[\s\S]*?return;[\s\S]*?sendProblem\s*\([^;]*["']unauthorized["']/.test(
        slice,
      );
    if (!fallthrough) continue;
    if (
      /throw\s+err\b/.test(slice) ||
      /InfrastructureError/.test(slice) ||
      /isInfrastructureError/.test(slice)
    ) {
      continue;
    }
    record(
      filePath,
      i + 1,
      lines[i],
      "AuthError branch followed by unauthorized fallthrough without rethrow (STH-46 pattern)",
    );
    break; // one report per file for this pattern
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
  const fixtureFiles = violations.map((v) => path.basename(v.file));
  const required = [
    "bad-auth-catch.ts",
    "bad-auth-catch-forbidden.ts",
    "bad-auth-catch-null.ts",
    "bad-map-auth-error.ts",
  ];
  const missing = required.filter((f) => !fixtureFiles.includes(f));
  if (violations.length < 4 || missing.length > 0) {
    console.error(
      "check-auth-error-classification: expected violations in each bad-auth-* fixture; missing:",
      missing.length ? missing.join(", ") : "(insufficient count)",
      `\n  got ${violations.length} from: ${[...new Set(fixtureFiles)].join(", ") || "(none)"}`,
    );
    process.exit(1);
  }
  console.log(
    `check-auth-error-classification: negative proof OK (${violations.length} violation(s) across fixtures)`,
  );
  process.exit(0);
}

if (violations.length > 0) {
  console.error("check-auth-error-classification: forbidden auth-error collapse:");
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line}: ${v.reason} :: ${v.text}`);
  }
  process.exit(1);
}

console.log("check-auth-error-classification: OK");
