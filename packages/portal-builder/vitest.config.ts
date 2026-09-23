import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A Node program: reads a filesystem, spawns a helper, writes an artifact. No DOM.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/astro/**", "src/cli/dev.ts"],
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});
