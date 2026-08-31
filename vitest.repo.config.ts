import { defineConfig } from "vitest/config";

import { assayWorkspaceAliases } from "./vitest.aliases.js";

export default defineConfig({
  resolve: { alias: assayWorkspaceAliases },
  test: {
    name: "repository-checks",
    include: ["scripts/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    passWithNoTests: true
  }
});
