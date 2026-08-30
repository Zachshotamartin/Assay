import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectArchitecture } from "./check-architecture.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("architecture boundary checker", () => {
  it("rejects an unallowlisted package-to-package import with file and line", async () => {
    const rootDir = fileURLToPath(
      new URL("../fixtures/repos/architecture-illegal-edge/", import.meta.url)
    );

    await expect(inspectArchitecture(rootDir)).resolves.toEqual([
      expect.objectContaining({
        code: "disallowed-package-edge",
        file: "packages/alpha/src/index.ts",
        line: 1,
        importer: "packages/alpha",
        imported: "packages/beta"
      })
    ]);
  });

  it("rejects every package import from an app", async () => {
    const rootDir = fileURLToPath(
      new URL("../fixtures/repos/architecture-imports-app/", import.meta.url)
    );

    await expect(inspectArchitecture(rootDir)).resolves.toEqual([
      expect.objectContaining({
        code: "package-imports-app",
        file: "packages/alpha/src/index.ts",
        line: 1,
        importer: "packages/alpha",
        imported: "apps/cli"
      })
    ]);
  });

  it("accepts the declared dependency graph of the real repository", async () => {
    await expect(inspectArchitecture(repositoryRoot)).resolves.toEqual([]);
  });
});

