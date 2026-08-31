import { defineConfig } from "vitest/config";

import { assayWorkspaceAliases } from "../../vitest.aliases.js";

export default defineConfig({
  resolve: { alias: assayWorkspaceAliases },
  test: {
    name: "cli",
    include: ["src/**/*.test.ts", "test/integration/**/*.test.ts"],
    passWithNoTests: true
  }
});
