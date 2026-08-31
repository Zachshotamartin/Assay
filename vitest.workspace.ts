import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "vitest.repo.config.ts",
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts"
]);
