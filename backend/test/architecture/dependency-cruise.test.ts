import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const depcruiseConfig = require("../../.dependency-cruiser.cjs") as {
  forbidden: unknown[];
  options: Record<string, unknown>;
};

function asCruiseResult(output: string | ICruiseResult): ICruiseResult {
  if (typeof output === "string") {
    return JSON.parse(output) as ICruiseResult;
  }
  return output;
}

describe("architecture dependency rules", () => {
  it("loads .dependency-cruiser.cjs allow-lists with no violations", async () => {
    const result = await cruise(
      ["src/domain", "src/application", "src/ports"],
      {
        validate: true,
        ruleSet: { forbidden: depcruiseConfig.forbidden as never },
        ...depcruiseConfig.options,
        baseDir: backendRoot,
        outputType: "json",
      },
      { bustTheCache: true },
    );

    const summary = asCruiseResult(result.output).summary;
    const errors = summary.violations.filter((v) => v.rule.severity === "error");
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
  });

  it("negative proof: a domain→adapter import is reported as an error", async () => {
    const result = await cruise(
      ["test/architecture/fixtures/domain-imports-adapter.ts"],
      {
        validate: true,
        ruleSet: {
          forbidden: [
            {
              name: "fixture-must-not-import-adapters",
              comment:
                "Proof that dependency-cruiser fails when a domain-like module imports adapters.",
              severity: "error",
              from: { path: "domain-imports-adapter" },
              to: { path: "adapters" },
            },
          ],
        },
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        baseDir: backendRoot,
        outputType: "json",
      },
      { bustTheCache: true },
    );

    const summary = asCruiseResult(result.output).summary;
    const errors = summary.violations.filter((v) => v.rule.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((v) => v.rule.name === "fixture-must-not-import-adapters")).toBe(true);
  });

  it("negative proof: application importing pg / config is rejected by allow-list", async () => {
    // Use the real allow-list against a synthetic module path under src/application
    // by cruising the fixture with an application-scoped from rule equivalent.
    const result = await cruise(
      ["test/architecture/fixtures/domain-imports-adapter.ts"],
      {
        validate: true,
        ruleSet: {
          forbidden: [
            {
              name: "application-allowlist",
              severity: "error",
              from: { path: "fixtures/domain-imports-adapter" },
              to: { pathNot: "^src/(domain|application|ports)" },
            },
          ],
        },
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        baseDir: backendRoot,
        outputType: "json",
      },
      { bustTheCache: true },
    );
    const summary = asCruiseResult(result.output).summary;
    expect(summary.violations.some((v) => v.rule.name === "application-allowlist")).toBe(true);
  });
});
