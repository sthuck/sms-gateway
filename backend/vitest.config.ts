import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // DB integration tests mutate a shared Postgres; run files sequentially.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
