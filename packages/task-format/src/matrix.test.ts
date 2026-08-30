import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@assay/contracts";
import { describe, expect, it } from "vitest";

import {
  expandMatrix,
  parseMatrixBytes,
  validateMatrixDocument,
  type LoadedYaml,
  type MatrixDocument,
  type TaskDocument
} from "./index.js";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const baseTask: LoadedYaml<TaskDocument> = {
  path: "/project/base.task.yaml",
  source: "",
  document: {
    format_version: "1.0",
    id: "matrix-task",
    title: "Run ${{ matrix.zeta }} with ${{ matrix.alpha }}",
    fixture: { path: "./fixture-${{ matrix.alpha }}" },
    prompt: "Use ${{ matrix.zeta }} and ${{ matrix.alpha }}.",
    toolset: { catalog: "simulated/1" },
    sandbox: {
      image: `example.invalid/fixture@sha256:${digest}`,
      env: { MATRIX_VALUE: "${{ matrix.alpha }}" }
    },
    assertions: [
      {
        type: "tests_pass",
        command: ["node", "${{ matrix.zeta }}", "${{ matrix.alpha }}"]
      }
    ],
    run_policy: { n: 7 }
  }
};

function loadedMatrix(document: MatrixDocument): LoadedYaml<MatrixDocument> {
  return { path: "/project/variants.matrix.yaml", source: "", document };
}

function staticBaseTask(path = "/project/base.task.yaml"): LoadedYaml<TaskDocument> {
  return {
    ...baseTask,
    path,
    document: {
      format_version: "1.0",
      id: "matrix-task",
      title: "Static matrix fixture",
      fixture: { path: "./fixture" },
      prompt: "Run the matrix fixture.",
      toolset: { catalog: "simulated/1" },
      sandbox: { image: `example.invalid/fixture@sha256:${digest}` },
      assertions: [{ type: "exit_code", equals: 0 }]
    }
  };
}

describe("deterministic matrix expansion", () => {
  it("uses declaration-order cross product and lexicographically sorted ID axes", () => {
    const matrix = loadedMatrix({
      format_version: "1.0",
      task: "./base.task.yaml",
      axes: {
        zeta: ["b", "a"],
        alpha: [2, 1]
      }
    });

    const expanded = expandMatrix(matrix, baseTask);

    expect(expanded.map((task) => task.document["id"])).toEqual([
      "matrix-task[alpha=2,zeta=b]",
      "matrix-task[alpha=1,zeta=b]",
      "matrix-task[alpha=2,zeta=a]",
      "matrix-task[alpha=1,zeta=a]"
    ]);
    expect(expanded[0]?.document).toMatchObject({
      title: "Run b with 2",
      fixture: { path: "./fixture-2" },
      prompt: "Use b and 2.",
      sandbox: { env: { MATRIX_VALUE: "2" } },
      assertions: [{ command: ["node", "b", "2"] }],
      run_policy: { n: 7 }
    });
    expect(expanded[0]?.fieldOrigins["fixture"]).toBe(baseTask.path);
    expect(expanded[0]?.fieldOrigins["assertions"]).toBe(baseTask.path);
  });

  it("is byte-stable and applies partial exclusion selectors deterministically", () => {
    const matrix = loadedMatrix({
      format_version: "1.0",
      task: "./base.task.yaml",
      axes: { zeta: ["b", "a"], alpha: [2, 1] },
      exclude: [{ zeta: "a" }]
    });

    const first = expandMatrix(matrix, baseTask);
    const second = expandMatrix(matrix, baseTask);

    expect(first).toHaveLength(2);
    expect(canonicalJson(first.map((entry) => entry.document))).toBe(
      canonicalJson(second.map((entry) => entry.document))
    );
  });

  it("rejects the seeded post-stringification ID collision fixture", async () => {
    const fixturePath = fileURLToPath(
      new URL("../fixtures/matrices/collision.matrix.yaml", import.meta.url)
    );
    const matrix = parseMatrixBytes(await readFile(fixturePath), fixturePath);

    const fixtureBase = staticBaseTask(
      resolve(dirname(fixturePath), matrix.document.task)
    );

    expect(() => expandMatrix(matrix, fixtureBase)).toThrowError(
      expect.objectContaining({
        category: "task_invalid",
        code: "task_invalid/matrix-id-collision",
        combinations: [
          { value: 1 },
          { value: "1" }
        ]
      })
    );
  });

  it.each([
    [{ zeta: ["a"], alpha: [1], extra: [true] }, "task_invalid/matrix-placeholder"],
    [{ zeta: ["a"], alpha: [1] }, "task_invalid/matrix-placeholder"]
  ] as const)("rejects unknown or unresolved placeholders", (axes, code) => {
    const invalidBase: LoadedYaml<TaskDocument> = {
      ...baseTask,
      document: { ...baseTask.document, prompt: "${{ matrix.missing }}" }
    };
    expect(() =>
      expandMatrix(
        loadedMatrix({
          format_version: "1.0",
          task: "./base.task.yaml",
          axes
        }),
        invalidBase
      )
    ).toThrowError(expect.objectContaining({ category: "task_invalid", code }));
  });

  it("rejects invalid exclusions, all-excluded matrices, and products above 64", () => {
    const common = {
      format_version: "1.0",
      task: "./base.task.yaml"
    } as const;

    expect(() =>
      expandMatrix(
        loadedMatrix({ ...common, axes: { zeta: ["a"], alpha: [1] }, exclude: [{ nope: 1 }] }),
        baseTask
      )
    ).toThrowError(expect.objectContaining({ code: "task_invalid/matrix-exclude" }));

    expect(() =>
      expandMatrix(
        loadedMatrix({ ...common, axes: { zeta: ["a"], alpha: [1] }, exclude: [{ zeta: "a" }] }),
        baseTask
      )
    ).toThrowError(expect.objectContaining({ code: "task_invalid/matrix-empty" }));

    expect(() =>
      expandMatrix(
        loadedMatrix({
          ...common,
          axes: {
            zeta: Array.from({ length: 9 }, (_, index) => `z${index}`),
            alpha: Array.from({ length: 8 }, (_, index) => index)
          }
        }),
        baseTask
      )
    ).toThrowError(expect.objectContaining({ code: "task_invalid/matrix-size" }));
  });

  it("accepts one-character axis names and enforces the 128-character instance-id bound", () => {
    const oneCharacterAxis = loadedMatrix({
      format_version: "1.0",
      task: "./base.task.yaml",
      axes: { x: ["ok"] }
    });
    expect(validateMatrixDocument(oneCharacterAxis.document)).toEqual({ ok: true });
    const oneCharacterBase = staticBaseTask();
    const expanded = expandMatrix(oneCharacterAxis, {
      ...oneCharacterBase,
      document: { ...oneCharacterBase.document, prompt: "${{ matrix.x }}" }
    });
    expect(expanded[0]?.document["id"]).toBe(
      "matrix-task[x=ok]"
    );
    expect(expanded[0]?.document["prompt"]).toBe("ok");

    const overlong = loadedMatrix({
      format_version: "1.0",
      task: "./base.task.yaml",
      axes: { x: ["v".repeat(120)] }
    });
    expect(() => expandMatrix(overlong, staticBaseTask())).toThrowError(
      expect.objectContaining({
        category: "task_invalid",
        code: "task_invalid/matrix-id-length"
      })
    );
  });
});
