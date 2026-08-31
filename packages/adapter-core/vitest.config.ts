import { defineConfig } from "vitest/config";

import { assayWorkspaceAliases } from "../../vitest.aliases.js";

export default defineConfig({
  resolve: { alias: assayWorkspaceAliases },
  test: {
    name: "adapter-core",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false
  }
});
