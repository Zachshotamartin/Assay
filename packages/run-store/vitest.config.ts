import { defineConfig } from "vitest/config";

import { assayWorkspaceAliases } from "../../vitest.aliases.js";

export default defineConfig({
  resolve: { alias: assayWorkspaceAliases },
  test: {
    name: "run-store",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 20_000
  }
});
