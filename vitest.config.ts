import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/decoder/**", "src/ingestion/**", "src/storage/**", "src/ledger-source/**"],
      exclude: ["**/index.ts", "**/types.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 65,
      },
    },
  },
});
