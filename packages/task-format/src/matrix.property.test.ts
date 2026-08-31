import { canonicalJson } from "@assay/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  expandMatrix,
  type LoadedYaml,
  type MatrixDocument,
  type MatrixScalar,
  type TaskDocument
} from "./index.js";

const MATRIX_SEED = 0x4153_5341;
const AXIS_NAMES = ["alpha", "beta", "delta", "gamma"] as const;

const scalar = fc.oneof(
  fc.integer({ min: 0, max: 9 }),
  fc.boolean(),
  fc.stringMatching(/^s[a-z]{1,3}$/u)
);

const axis = fc.tuple(
  fc.constantFrom(...AXIS_NAMES),
  fc.uniqueArray(scalar, {
    minLength: 1,
    maxLength: 3,
    selector: (value) => String(value)
  })
);

const axes = fc.uniqueArray(axis, {
  minLength: 1,
  maxLength: 4,
  selector: ([name]) => name
}).filter((entries) =>
  entries.reduce((product, [, values]) => product * values.length, 1) <= 64);

function task(): LoadedYaml<TaskDocument> {
  return {
    path: "/project/base.task.yaml",
    source: "",
    document: {
      format_version: "1.0",
      id: "matrix-task",
      title: "Generated matrix task",
      fixture: { path: "./fixture" },
      prompt: "Run the generated matrix task.",
      toolset: { catalog: "simulated/1" },
      sandbox: {
        image: "example.invalid/fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      assertions: [{ type: "exit_code", equals: 0 }]
    }
  };
}

function matrix(entries: readonly (readonly [string, readonly MatrixScalar[]])[]): LoadedYaml<MatrixDocument> {
  return {
    path: "/project/generated.matrix.yaml",
    source: "",
    document: {
      format_version: "1.0",
      task: "./base.task.yaml",
      axes: Object.fromEntries(entries)
    }
  };
}

function combinations(
  entries: readonly (readonly [string, readonly MatrixScalar[]])[]
): readonly Readonly<Record<string, MatrixScalar>>[] {
  let result: readonly Readonly<Record<string, MatrixScalar>>[] = [{}];
  for (const [name, values] of entries) {
    result = result.flatMap((prior) => values.map((value) => ({ ...prior, [name]: value })));
  }
  return result;
}

describe("matrix expansion properties", () => {
  it("is byte-stable, complete, ordered, and collision-free for seeded matrices", () => {
    fc.assert(fc.property(axes, (entries) => {
      const first = expandMatrix(matrix(entries), task());
      const second = expandMatrix(matrix(entries), task());
      const expected = combinations(entries);

      expect(first.map(({ matrixValues }) => matrixValues)).toEqual(expected);
      expect(first).toHaveLength(expected.length);
      expect(canonicalJson(first)).toBe(canonicalJson(second));

      const ids = first.map(({ document }) => document["id"] as string);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id.length <= 128)).toBe(true);
      expect(ids).toEqual(expected.map((values) => {
        const bindings = Object.keys(values).sort()
          .map((name) => `${name}=${String(values[name])}`)
          .join(",");
        return `matrix-task[${bindings}]`;
      }));
    }), { seed: MATRIX_SEED, numRuns: 500 });
  });
});
