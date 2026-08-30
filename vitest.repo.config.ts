import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "repository-checks",
    include: ["scripts/**/*.test.ts"],
    passWithNoTests: true
  }
});
