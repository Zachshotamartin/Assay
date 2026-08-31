import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSuite, resolveSuite } from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("R1 clean-clone reference fixture", () => {
  it("resolves the runnable suite and directory-validation copy to the same task bytes", async () => {
    const runnable = await resolveSuite(
      await loadSuite(resolve(repositoryRoot, "fixtures/suites/reference.suite.yaml")),
      { projectRoot: repositoryRoot }
    );
    const validation = await resolveSuite(
      await loadSuite(resolve(repositoryRoot, "fixtures/suites/reference/core.suite.yaml")),
      { projectRoot: repositoryRoot }
    );

    expect(runnable.tasks.map(({ document }) => document["id"])).toEqual(["reference-task"]);
    expect(validation.tasks.map(({ document }) => document["id"])).toEqual(["reference-task"]);
    expect(validation.suiteContentHash).toBe(runnable.suiteContentHash);
    const variants = runnable.suite.document["variants"];
    expect(variants).toEqual(expect.any(Object));
    if (typeof variants !== "object" || variants === null || Array.isArray(variants)) {
      throw new Error("validated reference suite variants were not an object");
    }
    expect(Object.keys(variants)).toEqual(["baseline"]);

    const task = runnable.tasks[0]!;
    const fixture = task.document["fixture"];
    expect(fixture).toEqual({ path: "repo" });
    const fixtureOrigin = task.fieldOrigins["fixture"]!;
    await expect(stat(resolve(fixtureOrigin, "..", "repo/README.md")))
      .resolves.toMatchObject({ size: expect.any(Number) });
  });
});
