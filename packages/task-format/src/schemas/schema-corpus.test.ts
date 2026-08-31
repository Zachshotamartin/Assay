import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { validateSuiteDocument, validateTaskDocument } from "../schema.js";

type JsonObject = Record<string, unknown>;
type JsonPath = readonly (string | number)[];

const fixtureUrl = (name: string): URL =>
  new URL(`../../fixtures/schemas/accept/${name}`, import.meta.url);

async function fixture(name: string): Promise<JsonObject> {
  return parse(await readFile(fileURLToPath(fixtureUrl(name)), "utf8"), {
    schema: "core",
    uniqueKeys: true
  }) as JsonObject;
}

function targetAt(root: unknown, path: JsonPath): JsonObject {
  let target = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(target)) throw new Error(`expected array at ${JSON.stringify(path)}`);
      target = target[segment];
    } else {
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        throw new Error(`expected object at ${JSON.stringify(path)}`);
      }
      target = (target as JsonObject)[segment];
    }
  }
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new Error(`expected object target at ${JSON.stringify(path)}`);
  }
  return target as JsonObject;
}

function expectUnknownFieldRejected(
  document: JsonObject,
  path: JsonPath,
  validate: typeof validateTaskDocument
): void {
  const candidate = structuredClone(document);
  targetAt(candidate, path)["unexpected_field"] = true;
  const result = validate(candidate);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        keyword: "additionalProperties",
        params: expect.objectContaining({ additionalProperty: "unexpected_field" })
      })
    ]));
  }
}

describe("complete task and suite schema boundary corpus", () => {
  it("rejects unknown fields at every published task object boundary", async () => {
    const task = await fixture("every-field.task.yaml");
    const paths: JsonPath[] = [
      [],
      ["fixture"],
      ["fixture", "archive"],
      ["toolset"],
      ["sandbox"],
      ["budgets"],
      ["budgets", "tokens"],
      ["budgets", "wall_clock_ms"],
      ["budgets", "tool_calls"],
      ["budgets", "dollars"],
      ["run_policy"],
      ["judge"],
      ["judge", "model"],
      ["trajectory_expectations"],
      ["trajectory_expectations", "ordering", 0]
    ];
    const assertions = task["assertions"] as readonly unknown[];
    paths.push(...assertions.map((_assertion, index) => ["assertions", index] as const));

    for (const path of paths) {
      expectUnknownFieldRejected(task, path, validateTaskDocument);
    }
  });

  it("rejects unknown fields at every published suite object boundary", async () => {
    const suite = await fixture("every-field.suite.yaml");
    const paths: JsonPath[] = [
      [],
      ["tags"],
      ["budgets"],
      ["budgets", "tokens"],
      ["budgets", "wall_clock_ms"],
      ["budgets", "tool_calls"],
      ["budgets", "dollars"],
      ["run_policy"],
      ["variants"],
      ["variants", "baseline"],
      ["variants", "candidate"],
      ["comparison"]
    ];

    for (const path of paths) {
      expectUnknownFieldRejected(suite, path, validateSuiteDocument);
    }
  });

  it("rejects a wrong type for every task top-level field", async () => {
    const task = await fixture("every-field.task.yaml");
    const wrongValues: Readonly<Record<string, unknown>> = {
      format_version: 1,
      id: 1,
      title: [],
      description: false,
      tags: "bugfix",
      "+append:tags": "typescript",
      abstract: "false",
      extends: 7,
      fixture: "fixture",
      prompt: 9,
      toolset: [],
      sandbox: "container",
      assertions: {},
      budgets: [],
      run_policy: "ten",
      judge: [],
      trajectory_expectations: "tools"
    };

    for (const [field, wrongValue] of Object.entries(wrongValues)) {
      const candidate = structuredClone(task);
      candidate[field] = wrongValue;
      expect(validateTaskDocument(candidate).ok, field).toBe(false);
    }
  });

  it("rejects a wrong type for every suite top-level field", async () => {
    const suite = await fixture("every-field.suite.yaml");
    const wrongValues: Readonly<Record<string, unknown>> = {
      format_version: 1,
      id: 1,
      title: [],
      include: "tasks/*.task.yaml",
      tags: [],
      budgets: "budgets",
      spend_ceiling_dollars: "five",
      run_policy: 10,
      variants: [],
      comparison: "baseline",
      allow_same_family_judge: "false"
    };

    for (const [field, wrongValue] of Object.entries(wrongValues)) {
      const candidate = structuredClone(suite);
      candidate[field] = wrongValue;
      expect(validateSuiteDocument(candidate).ok, field).toBe(false);
    }
  });

  it("accepts every mutually exclusive task-field branch", async () => {
    const task = await fixture("every-field.task.yaml");
    task["fixture"] = { path: "fixtures/repository", git_init: false };
    task["prompt"] = "Use the literal prompt branch.";
    task["assertions"] = [
      { type: "exit_code" },
      { type: "file_exists", path: "result", kind: "dir" },
      { type: "file_contains", path: "result.txt", regex: "done$" },
      { type: "command_output", command: ["node", "cli.js"], equals: "done" }
    ];

    expect(validateTaskDocument(task)).toEqual({ ok: true });
    (task["assertions"] as JsonObject[])[3] = {
      type: "command_output",
      command: ["node", "cli.js"],
      regex: "^done$"
    };
    expect(validateTaskDocument(task)).toEqual({ ok: true });
  });
});
