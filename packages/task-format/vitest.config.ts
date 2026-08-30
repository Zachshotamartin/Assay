import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "task-format",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false
  }
});
