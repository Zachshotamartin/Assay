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
});
