import { defineConfig } from "vitest/config";

import { assayWorkspaceAliases } from "../../vitest.aliases.js";

export default defineConfig({
  resolve: { alias: assayWorkspaceAliases },
  test: {
    name: "assertions",
    include: ["src/**/*.test.ts", "test/integration/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 15_000
  }
});
