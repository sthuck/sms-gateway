/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-allowlist",
      comment: "Domain may only import other domain modules (pure TS).",
      severity: "error",
      from: { path: "^src/domain" },
      to: { pathNot: "^src/domain" },
    },
    {
      name: "application-allowlist",
      comment: "Application may only import domain, ports, and other application modules.",
      severity: "error",
      from: { path: "^src/application" },
      to: { pathNot: "^src/(domain|application|ports)" },
    },
    {
      name: "ports-allowlist",
      comment: "Ports may only import domain types and other ports.",
      severity: "error",
      from: { path: "^src/ports" },
      to: { pathNot: "^src/(domain|ports)" },
    },
    {
      name: "application-no-config-shim",
      comment: "Application must not import src/config.ts or src/app.ts.",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/(config|app)\\." },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".mjs", ".cjs"],
    },
  },
};
