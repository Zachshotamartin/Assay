import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  SUPPORTED_FORMAT_VERSION,
  validateSuiteDocument,
  validateTaskDocument
} from "../schema.js";

const fixtureUrl = (name: string): URL =>
  new URL(`../../fixtures/schemas/${name}`, import.meta.url);

async function readYamlFixture(name: string): Promise<unknown> {
  const bytes = await readFile(fileURLToPath(fixtureUrl(name)), "utf8");
  return parse(bytes, { schema: "core", uniqueKeys: true });
}

describe("task and suite JSON Schema fixture corpus", () => {
  it("accepts the version-stamped fixtures covering every published field", async () => {
    const task = await readYamlFixture("accept/every-field.task.yaml");
    const abstractTask = await readYamlFixture("accept/abstract.task.yaml");
    const suite = await readYamlFixture("accept/every-field.suite.yaml");

    expect(SUPPORTED_FORMAT_VERSION).toBe("1.0");
    expect(validateTaskDocument(task)).toEqual({ ok: true });
    expect(validateTaskDocument(abstractTask)).toEqual({ ok: true });
    expect(validateSuiteDocument(suite)).toEqual({ ok: true });
  });

  it.each([
    "reject/unknown-major.task.yaml",
    "reject/unknown-top-level.task.yaml",
    "reject/unknown-nested.task.yaml",
    "reject/invalid-fixture-choice.task.yaml",
    "reject/invalid-assertion-field.task.yaml"
  ])("rejects task schema fixture %s", async (fixture) => {
    const result = validateTaskDocument(await readYamlFixture(fixture));
    expect(result.ok).toBe(false);
  });

  it.each([
    "reject/unknown-major.suite.yaml",
    "reject/unknown-top-level.suite.yaml",
    "reject/unknown-nested.suite.yaml",
    "reject/invalid-alpha.suite.yaml",
    "reject/invalid-budget-scope.suite.yaml"
  ])("rejects suite schema fixture %s", async (fixture) => {
    const result = validateSuiteDocument(await readYamlFixture(fixture));
    expect(result.ok).toBe(false);
  });

  it("uses the stable unsupported-version code for unknown majors", async () => {
    const task = validateTaskDocument(
      await readYamlFixture("reject/unknown-major.task.yaml")
    );
    const suite = validateSuiteDocument(
      await readYamlFixture("reject/unknown-major.suite.yaml")
    );

    expect(task).toMatchObject({
      ok: false,
      code: "task_invalid/format-version-unsupported"
    });
    expect(suite).toMatchObject({
      ok: false,
      code: "suite_invalid/format-version-unsupported"
    });
  });
});
