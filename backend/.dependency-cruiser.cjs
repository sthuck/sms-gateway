/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-no-adapters",
      comment: "Domain must stay pure — no adapters or frameworks.",
      severity: "error",
      from: { path: "^src/domain" },
      to: {
        path: "^src/adapters|^src/composition|^src/device|^src/queue|^src/routes",
      },
    },
    {
      name: "domain-no-frameworks",
      comment: "Domain must not import Fastify, pg, drizzle, openid-client, or jose.",
      severity: "error",
      from: { path: "^src/domain" },
      to: {
        path: "node_modules/(fastify|@fastify|pg|drizzle-orm|openid-client|jose)/",
        pathNot: "node_modules/dependency-cruiser",
      },
    },
    {
      name: "application-no-adapters",
      comment: "Application use cases depend only on ports/domain.",
      severity: "error",
      from: { path: "^src/application" },
      to: {
        path: "^src/adapters|^src/composition|^src/device|^src/queue|^src/routes",
      },
    },
    {
      name: "application-no-frameworks",
      comment: "Application must not import Fastify, pg, drizzle, openid-client, or jose.",
      severity: "error",
      from: { path: "^src/application" },
      to: {
        path: "node_modules/(fastify|@fastify|pg|drizzle-orm|openid-client|jose)/",
      },
    },
    {
      name: "ports-no-adapters",
      severity: "error",
      from: { path: "^src/ports" },
      to: {
        path: "^src/adapters|^src/composition|^src/application|^src/device|^src/queue",
      },
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
