import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectDocumentation } from "./check-docs.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/repos/${name}/`, import.meta.url));
}

describe("documentation consistency checker", () => {
  it("accepts a status-aligned explicitly planned fixture", async () => {
    await expect(inspectDocumentation(fixture("docs-valid"))).resolves.toEqual([]);
  });

  it("rejects a drifted gate status with file and line", async () => {
    await expect(inspectDocumentation(fixture("docs-status-drift"))).resolves.toEqual([
      expect.objectContaining({
        code: "gate-status-drift",
        file: "README.md",
        line: 13,
        gate: "R4"
      })
    ]);
  });

  it("rejects a missing verbatim current-claim block", async () => {
    await expect(inspectDocumentation(fixture("docs-missing-claim"))).resolves.toEqual([
      expect.objectContaining({
        code: "current-claim-missing",
        file: "docs/BUILD_PLAN.md",
        line: 1
      })
    ]);
  });

  it("rejects an unqualified install command for a planned release", async () => {
    await expect(inspectDocumentation(fixture("docs-forbidden-install"))).resolves.toEqual([
      expect.objectContaining({
        code: "forbidden-install-command",
        file: "README.md",
        line: 23
      })
    ]);
  });
});
