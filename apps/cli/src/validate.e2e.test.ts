import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli, type CliIo, type CliRuntime } from "./cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "assay-validate-e2e-"));
  roots.push(root);
  return root;
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    },
    stdout,
    stderr
  };
}

function validationRuntime(root: string): {
  readonly runtime: CliRuntime;
  readonly adapterResolutions: () => number;
} {
  let adapterResolutions = 0;
  const unavailableIds = {
    next(): never {
      throw new Error("validation requested an identifier");
    }
  };
  return {
    runtime: {
      projectRoot: root,
      environment: {},
      clock: {
        wallTime: () => "2026-08-30T12:00:00.000Z",
        monotonicMilliseconds: () => {
          throw new Error("validation requested a runtime clock");
        }
      },
      runIdSource: unavailableIds,
      taskRunIdSource: unavailableIds,
      eventIdSource: unavailableIds,
      processId: process.pid,
      signal: new AbortController().signal,
      adapterCommandFor: () => {
        adapterResolutions += 1;
        throw new Error("validation attempted to resolve an adapter");
      }
    },
    adapterResolutions: () => adapterResolutions
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function taskDocument(
  id: string,
  assertions: readonly Readonly<Record<string, unknown>>[],
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    format_version: "1.0",
    id,
    title: `Validation task ${id}`,
    fixture: { path: "repo" },
    prompt: "Validate this task without executing it.",
    toolset: { catalog: "simulated/1" },
    sandbox: {
      image: `synthetic.invalid/validation@sha256:${"0".repeat(64)}`,
      network: "none"
    },
    assertions,
    ...overrides
  };
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(path);
      } else if (child.isFile()) {
        entries.push(`${relative(root, path)}\0${(await readFile(path)).toString("base64")}`);
      }
    }
  };
  await visit(root);
  return entries;
}

async function writeValidValidationCorpus(root: string): Promise<void> {
  const tasks = join(root, "tasks");
  await mkdir(join(tasks, "repo"), { recursive: true });
  await mkdir(join(tasks, "calibration"), { recursive: true });
  await writeFile(join(tasks, "repo", "README.md"), "synthetic validation fixture\n", "utf8");
  await writeFile(
    join(tasks, "calibration", "quality-v1.jsonl"),
    `${Array.from({ length: 50 }, (_, index) => JSON.stringify({ id: `item-${index + 1}`, label: 1 })).join("\n")}\n`,
    "utf8"
  );
  await writeFile(join(tasks, "quality.checker.ts"), `
import type { CheckerContext, CheckerVerdict } from "@assay/checker-api";
throw new Error("FR-TASK-010 checker module was executed during validation");
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  return { verdict: "pass", observed: "static", expectation: "static" };
}
`, "utf8");
  await writeJson(join(tasks, "quality.rubric.yaml"), {
    format_version: "1.0",
    id: "quality",
    version: 1,
    criteria: [
      { id: "correctness", description: "The result is correct.", weight: 0.6 },
      { id: "clarity", description: "The result is clear.", weight: 0.4 }
    ],
    calibration: {
      set: "calibration/quality-v1.jsonl",
      labeled_items: 50,
      provenance: "Two synthetic maintainers labeled every synthetic item."
    }
  });
  await writeJson(join(tasks, "valid.task.yaml"), taskDocument("valid-task", [
    { type: "file_exists", path: "README.md" },
    { type: "checker", module: "quality.checker.ts" },
    { type: "judge", rubric: "quality.rubric.yaml", threshold: 0.75, advisory: true }
  ]));
  await writeJson(join(tasks, "matrix-base.task.yaml"), taskDocument(
    "matrix-base",
    [{ type: "file_exists", path: "README.md" }],
    {
      title: "Matrix ${{ matrix.mode }}",
      prompt: "Validate matrix mode ${{ matrix.mode }} without execution."
    }
  ));
  await writeJson(join(tasks, "matrix-base.matrix.yaml"), {
    format_version: "1.0",
    task: "matrix-base.task.yaml",
    axes: { mode: ["one"] }
  });
  await writeJson(join(root, "validation.suite.yaml"), {
    format_version: "1.0",
    id: "validation-suite",
    title: "Validation suite",
    include: ["tasks/valid.task.yaml"],
    variants: {
      baseline: { adapter: "simulated", model: "synthetic/scripted-v1" }
    }
  });

  for (const ignored of [".assay", ".git", "node_modules"]) {
    await mkdir(join(root, ignored), { recursive: true });
    await writeFile(join(root, ignored, "ignored.rubric.yaml"), "not: valid: yaml\n", "utf8");
  }
  await writeFile(join(tasks, "unreferenced.checker.ts"), "this is intentionally invalid", "utf8");
}

describe("FR-TASK-010 total side-effect-free validation", () => {
  it("discovers tasks, suites, matrices, referenced checkers, and rubrics without executing", async () => {
    const root = await projectRoot();
    await writeValidValidationCorpus(root);
    const before = await treeSnapshot(root);
    const output = capture();
    const { runtime, adapterResolutions } = validationRuntime(root);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("validation attempted network access");
    }) as typeof fetch;

    try {
      expect(await executeCli(["validate"], output.io, runtime), output.stderr.join(""))
        .toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(output.stderr).toEqual([]);
    expect(output.stdout.join("")).toMatch(/1 suite/u);
    expect(output.stdout.join("")).toMatch(/3 tasks/u);
    expect(output.stdout.join("")).toMatch(/1 matrix/u);
    expect(output.stdout.join("")).toMatch(/1 checker/u);
    expect(output.stdout.join("")).toMatch(/1 rubric/u);
    expect(adapterResolutions()).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(await treeSnapshot(root)).toEqual(before);
    await expect(stat(join(root, ".assay", "assay.db"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("supports normative validate globs and explicit checker/rubric paths", async () => {
    const root = await projectRoot();
    await writeValidValidationCorpus(root);
    const { runtime } = validationRuntime(root);

    const globbed = capture();
    expect(await executeCli(["validate", "tasks/**/*.task.yaml"], globbed.io, runtime), globbed.stderr.join(""))
      .toBe(0);
    expect(globbed.stdout.join("")).toMatch(/2 tasks/u);
    expect(globbed.stdout.join("")).toMatch(/1 checker/u);
    expect(globbed.stdout.join("")).toMatch(/1 rubric/u);

    const explicit = capture();
    expect(await executeCli([
      "validate", "tasks/quality.checker.ts", "tasks/quality.rubric.yaml"
    ], explicit.io, runtime), explicit.stderr.join(""))
      .toBe(0);
    expect(explicit.stdout.join("")).toMatch(/1 checker/u);
    expect(explicit.stdout.join("")).toMatch(/1 rubric/u);
  }, 30_000);

  it("aggregates deterministic line-column findings across and within documents", async () => {
    const root = await projectRoot();
    await mkdir(join(root, "repo"), { recursive: true });
    await writeFile(join(root, "repo", "README.md"), "synthetic\n", "utf8");
    await writeFile(join(root, "a-multi.task.yaml"), `format_version: "1.0"
id: INVALID_ID
title: ""
unknown_one: true
unknown_two: true
fixture: { path: repo }
prompt: Validate.
toolset: { catalog: simulated/1 }
sandbox:
  image: synthetic.invalid/validation@sha256:${"0".repeat(64)}
  network: none
assertions:
  - { type: file_exists, path: README.md }
`, "utf8");
    await writeJson(join(root, "b-references.task.yaml"), taskDocument(
      "reference-errors",
      [
        { type: "json_schema", path: "out.json", schema: "missing.schema.json" },
        { type: "diff_matches", expected: "missing.patch" },
        { type: "checker", module: "missing.checker.ts" }
      ],
      {
        fixture: { path: "missing-fixture" },
        prompt: { file: "missing.prompt.md" }
      }
    ));
    await writeFile(join(root, "broken.checker.ts"), `
import { readFile } from "node:fs";
export const notCheck = readFile;
`, "utf8");
    await writeJson(join(root, "c-checker.task.yaml"), taskDocument(
      "checker-errors",
      [{ type: "checker", module: "broken.checker.ts" }]
    ));
    await writeFile(join(root, "d-invalid.rubric.yaml"), `format_version: "1.0"
id: invalid-rubric
version: 1
criteria:
  - { id: duplicate, description: First criterion., weight: 0.8 }
  - { id: duplicate, description: Second criterion., weight: 0.8 }
calibration:
  set: missing-calibration.jsonl
  labeled_items: 2
  provenance: Synthetic labels.
unexpected: true
`, "utf8");

    const { runtime, adapterResolutions } = validationRuntime(root);
    const first = capture();
    const second = capture();
    expect(await executeCli(["validate"], first.io, runtime)).toBe(4);
    expect(await executeCli(["validate"], second.io, runtime)).toBe(4);
    expect(first.stdout).toEqual([]);
    expect(second.stdout).toEqual([]);
    expect(second.stderr).toEqual(first.stderr);
    expect(adapterResolutions()).toBe(0);

    const diagnostics = first.stderr.join("");
    expect(diagnostics).toMatch(/validation found [1-9][0-9]* diagnostics/u);
    expect(diagnostics).toMatch(/a-multi\.task\.yaml:2:[0-9]+ \$\.id task_invalid\/schema/u);
    expect(diagnostics).toMatch(/a-multi\.task\.yaml:3:[0-9]+ \$\.title task_invalid\/schema/u);
    expect(diagnostics).toMatch(/a-multi\.task\.yaml:4:[0-9]+ \$\.unknown_one task_invalid\/schema/u);
    expect(diagnostics).toMatch(/a-multi\.task\.yaml:5:[0-9]+ \$\.unknown_two task_invalid\/schema/u);
    expect(diagnostics).toContain("b-references.task.yaml");
    expect(diagnostics).toContain("missing.schema.json");
    expect(diagnostics).toContain("missing.patch");
    expect(diagnostics).toContain("missing.checker.ts");
    expect(diagnostics).toContain("missing.prompt.md");
    expect(diagnostics).toContain("missing-fixture");
    expect(diagnostics).toContain("checker_invalid/import-restriction");
    expect(diagnostics).toContain("task_invalid/rubric-criteria-id-duplicate");
    expect(diagnostics).toContain("task_invalid/rubric-weight-sum");
    expect(diagnostics).toContain("missing-calibration.jsonl");

    const renderedLines = diagnostics.split("\n").filter((line) => /^[^ ]+\.\w+/u.test(line));
    expect(renderedLines).toEqual([...renderedLines].sort((left, right) => {
      const leftKey = left.slice(0, left.indexOf(" task_invalid/") >= 0
        ? left.indexOf(" task_invalid/")
        : left.indexOf(" checker_invalid/"));
      const rightKey = right.slice(0, right.indexOf(" task_invalid/") >= 0
        ? right.indexOf(" task_invalid/")
        : right.indexOf(" checker_invalid/"));
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
