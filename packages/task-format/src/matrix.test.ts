import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@assay/contracts";
import { describe, expect, it } from "vitest";

import {
  expandMatrix,
  parseMatrixBytes,
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

    expect(() => expandMatrix(matrix, baseTask)).toThrowError(
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
});
