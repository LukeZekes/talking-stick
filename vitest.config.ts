import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 15_000,
    testTimeout: 30_000,
    globalSetup: "./tests/setup.ts",
    // tests/bun runs under `bun test` (npm run test:bun).
    exclude: ["**/node_modules/**", "tests/bun/**"]
  }
});
