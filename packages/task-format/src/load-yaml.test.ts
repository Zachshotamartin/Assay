import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_YAML_FILE_BYTES,
  TaskFormatError,
  loadSuite,
  loadTask,
  parseTaskBytes
} from "./index.js";

const schemaFixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/schemas/${name}`, import.meta.url));

describe("bounded safe YAML loading", () => {
  it("loads schema-valid task and suite files as inert plain data", async () => {
    delete (globalThis as Record<string, unknown>)["__assay_checker_loaded"];

    const task = await loadTask(schemaFixture("accept/every-field.task.yaml"));
    const suite = await loadSuite(schemaFixture("accept/every-field.suite.yaml"));

    expect(task.document["id"]).toBe("every-field");
    expect(suite.document["id"]).toBe("every-suite-field");
    expect(Object.getPrototypeOf(task.document)).toBe(Object.prototype);
    expect((globalThis as Record<string, unknown>)["__assay_checker_loaded"]).toBeUndefined();
  });

  it.each([
    ["reject/unknown-nested.task.yaml", "task_invalid"],
    ["reject/unknown-nested.suite.yaml", "suite_invalid"]
  ] as const)("reports category and source position for %s", async (fixture, category) => {
    const load = fixture.endsWith(".task.yaml") ? loadTask : loadSuite;

    await expect(load(schemaFixture(fixture))).rejects.toMatchObject({
      category,
      code: `${category}/schema`,
      filePath: schemaFixture(fixture),
      line: expect.any(Number),
      column: expect.any(Number),
      remedy: expect.any(String)
    });
  });

  it("rejects duplicate keys and custom tags with parse positions", async () => {
    const duplicate = new TextEncoder().encode(
      'format_version: "1.0"\nid: duplicate\nid: duplicate-again\nabstract: true\n'
    );
    const tagged = new TextEncoder().encode(
      'format_version: "1.0"\nid: tagged-value\nabstract: true\ndescription: !execute "touch /tmp/no"\n'
    );

    for (const [bytes, filePath] of [
      [duplicate, "/project/duplicate.task.yaml"],
      [tagged, "/project/tagged.task.yaml"]
    ] as const) {
      try {
        parseTaskBytes(bytes, filePath);
        throw new Error("expected parse rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskFormatError);
        expect(error).toMatchObject({
          category: "task_invalid",
          code: "task_invalid/yaml-parse",
          line: expect.any(Number),
          column: expect.any(Number)
        });
      }
    }
  });

  it("rejects bounded hostile alias expansion as inert task_invalid input", () => {
    const aliases = (anchor: string): string =>
      Array.from({ length: 10 }, () => `*${anchor}`).join(", ");
    const hostile = new TextEncoder().encode(
      'format_version: "1.0"\n' +
      'id: hostile-aliases\n' +
      'abstract: true\n' +
      'seed: &seed ["synthetic", "synthetic", "synthetic", "synthetic", "synthetic"]\n' +
      `level_one: &level_one [${aliases("seed")}]\n` +
      `level_two: &level_two [${aliases("level_one")}]\n` +
      `level_three: [${aliases("level_two")}]\n`
    );

    expect(() => parseTaskBytes(hostile, "/project/hostile-aliases.task.yaml"))
      .toThrowError(expect.objectContaining({
        category: "task_invalid",
        code: "task_invalid/yaml-parse",
        filePath: "/project/hostile-aliases.task.yaml",
        line: 1,
        column: 1,
        remedy: expect.stringContaining("100 aliases")
      }));
  });

  it("rejects non-UTF-8 and over-limit files before parsing", () => {
    expect(() =>
      parseTaskBytes(Uint8Array.of(0xc3, 0x28), "/project/invalid.task.yaml")
    ).toThrowError(
      expect.objectContaining({
        category: "task_invalid",
        code: "task_invalid/utf8"
      })
    );

    expect(() =>
      parseTaskBytes(
        new Uint8Array(MAX_YAML_FILE_BYTES + 1),
        "/project/oversized.task.yaml"
      )
    ).toThrowError(
      expect.objectContaining({
        category: "task_invalid",
        code: "task_invalid/file-too-large"
      })
    );
  });

  it("does not read or execute checker modules while loading", async () => {
    const taskBytes = await readFile(schemaFixture("accept/every-field.task.yaml"));
    const reads: string[] = [];

    const loaded = await loadTask("/project/inert.task.yaml", {
      readFile: async (path) => {
        reads.push(path);
        return taskBytes;
      }
    });

    expect(loaded.document["assertions"]).toEqual(expect.any(Array));
    expect(reads).toEqual(["/project/inert.task.yaml"]);
  });

  it("FR-TASK-012 warns when a task id differs from its file basename", () => {
    const bytes = new TextEncoder().encode(
      'format_version: "1.0"\nid: canonical-task\nabstract: true\n'
    );

    expect(parseTaskBytes(bytes, "/project/canonical-task.task.yaml").warnings).toEqual([]);
    expect(parseTaskBytes(bytes, "/project/renamed-file.task.yaml").warnings).toEqual([
      {
        code: "task_warning/id-file-name-mismatch",
        filePath: "/project/renamed-file.task.yaml",
        yamlPath: "$.id",
        message: "task id canonical-task differs from file basename renamed-file",
        remedy: "Rename the task file to canonical-task.task.yaml or change its id intentionally."
      }
    ]);
  });
});
