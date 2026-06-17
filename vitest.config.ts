import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Headroom so timing-sensitive suites don't spuriously time out when a
    // heavy benchmark (scale latency, 10k-fact ingest) co-runs under CPU load.
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/index.ts", "src/**/templates/**"],
    },
  },
});
