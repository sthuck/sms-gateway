import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function asCruiseResult(output: string | ICruiseResult): ICruiseResult {
  if (typeof output === "string") {
    return JSON.parse(output) as ICruiseResult;
  }
  return output;
}

describe("architecture dependency rules", () => {
  it("domain, application, and ports have no forbidden deps", async () => {
    const result = await cruise(
      ["src/domain", "src/application", "src/ports"],
      {
        validate: true,
        ruleSet: {
          forbidden: [
            {
              name: "domain-no-adapters",
              severity: "error",
              from: { path: "^src/domain" },
              to: { path: "^src/adapters|^src/composition" },
            },
            {
              name: "domain-no-frameworks",
              severity: "error",
              from: { path: "^src/domain" },
              to: {
                path: "node_modules/(fastify|@fastify|pg|drizzle-orm|openid-client|jose)/",
              },
            },
            {
              name: "application-no-adapters",
              severity: "error",
              from: { path: "^src/application" },
              to: { path: "^src/adapters|^src/composition" },
            },
            {
              name: "application-no-frameworks",
              severity: "error",
              from: { path: "^src/application" },
              to: {
                path: "node_modules/(fastify|@fastify|pg|drizzle-orm|openid-client|jose)/",
              },
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
});
