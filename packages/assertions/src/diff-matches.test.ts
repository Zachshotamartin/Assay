import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateDeterministicAssertion,
  validateDiffMatchesAssertion,
  type AssertionExecutionContext
} from "./index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })));
});

function fixedClock(): Clock {
  let time = 0;
  return {
    wallTime: () => "2026-08-30T00:00:00.000Z",
    monotonicMilliseconds: () => time++
  };
}

function context(workspaceRoot: string, fixtureRoot: string, projectRoot: string): AssertionExecutionContext {
  return {
    workspaceRoot,
    fixtureRoot,
    projectRoot,
    agentExitCode: 0,
    clock: fixedClock(),
    commandRunner: { run: async () => { throw new Error("unused"); } }
  };
}

async function writeTree(root: string, values: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [path, contents] of Object.entries(values)) {
    const target = join(root, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
}

describe("diff_matches", () => {
  it("matches added and removed multisets independent of context, offsets, and hunk order", async () => {
    const fixture = await temporaryDirectory("assay-diff-fixture-");
    const workspace = await temporaryDirectory("assay-diff-workspace-");
    const project = await temporaryDirectory("assay-diff-project-");
    await writeTree(fixture, {
      "src/a.ts": "zero\none\ntwo\nthree\nfour\n",
      "src/b.ts": "alpha\nbeta\n"
    });
    await writeTree(workspace, {
      "src/a.ts": "zero\nONE\ntwo\nthree\nFOUR   \n",
      "src/b.ts": "ALPHA\nbeta\n"
    });
    await writeTree(project, {
      "expected/change.patch": [
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -99,2 +40,2 @@ unrelated context text",
        "-alpha",
        "+ALPHA",
        " beta",
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -80 +70 @@",
        "-four",
        "+FOUR",
        "@@ -10,3 +20,3 @@",
        " zero",
        "-one",
        "+ONE",
        " two",
        ""
      ].join("\n")
    });

    const result = await evaluateDeterministicAssertion({
      type: "diff_matches",
      expected: "expected/change.patch",
      ignore_whitespace: "trailing"
    }, context(workspace, fixture, project), new AbortController().signal);

    expect(result).toMatchObject({
      type: "diff_matches",
      target: "workspace diff",
      verdict: "pass"
    });
  });

  it("fails on extra changed files unless paths excludes them", async () => {
    const fixture = await temporaryDirectory("assay-diff-extra-fixture-");
    const workspace = await temporaryDirectory("assay-diff-extra-workspace-");
    const project = await temporaryDirectory("assay-diff-extra-project-");
    await writeTree(fixture, { "a.txt": "old\n", "extra.txt": "before\n" });
    await writeTree(workspace, { "a.txt": "new\n", "extra.txt": "after\n" });
    await writeTree(project, {
      "expected.patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    });
    const executionContext = context(workspace, fixture, project);

    await expect(evaluateDeterministicAssertion({
      type: "diff_matches",
      expected: "expected.patch"
    }, executionContext, new AbortController().signal)).resolves.toMatchObject({ verdict: "fail" });
    await expect(evaluateDeterministicAssertion({
      type: "diff_matches",
      expected: "expected.patch",
      paths: ["a.txt"]
    }, executionContext, new AbortController().signal)).resolves.toMatchObject({ verdict: "pass" });
  });

  it("applies none, trailing, and all whitespace modes exactly", async () => {
    const fixture = await temporaryDirectory("assay-diff-space-fixture-");
    const workspace = await temporaryDirectory("assay-diff-space-workspace-");
    const project = await temporaryDirectory("assay-diff-space-project-");
    await writeTree(fixture, { "a.txt": "old value\n" });
    await writeTree(workspace, { "a.txt": "new    value   \n" });
    await writeTree(project, {
      "expected.patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old value\n+new value\n"
    });

    for (const [mode, verdict] of [
      ["none", "fail"],
      ["trailing", "fail"],
      ["all", "pass"]
    ] as const) {
      await expect(evaluateDeterministicAssertion({
        type: "diff_matches",
        expected: "expected.patch",
        ignore_whitespace: mode
      }, context(workspace, fixture, project), new AbortController().signal)).resolves.toMatchObject({ verdict });
    }
  });

  it("matches binary changes by the required final-content SHA-256 sidecar", async () => {
    const fixture = await temporaryDirectory("assay-diff-binary-fixture-");
    const workspace = await temporaryDirectory("assay-diff-binary-workspace-");
    const project = await temporaryDirectory("assay-diff-binary-project-");
    const changed = Uint8Array.from([0, 1, 2, 4]);
    await writeTree(fixture, { "asset.bin": Uint8Array.from([0, 1, 2, 3]) });
    await writeTree(workspace, { "asset.bin": changed });
    await writeTree(project, {
      "binary.patch": [
        "diff --git a/asset.bin b/asset.bin",
        "--- a/asset.bin",
        "+++ b/asset.bin",
        "Binary files a/asset.bin and b/asset.bin differ",
        "Assay-Binary-SHA256: 4c660defac5dabb4b4d02e701f5df046fffb5cd61f968208522ba083f5ec12a8",
        ""
      ].join("\n")
    });

    await expect(evaluateDeterministicAssertion({
      type: "diff_matches",
      expected: "binary.patch"
    }, context(workspace, fixture, project), new AbortController().signal)).resolves.toMatchObject({ verdict: "pass" });
  });

  it("rejects malformed and escaping patches as task_invalid before a run", async () => {
    const project = await temporaryDirectory("assay-diff-invalid-project-");
    await writeTree(project, {
      "malformed.patch": "--- a/a.txt\n+++ b/a.txt\n+no-hunk\n",
      "escape.patch": "--- a/../../secret\n+++ b/../../secret\n@@ -1 +1 @@\n-old\n+new\n"
    });

    await expect(validateDiffMatchesAssertion(
      { type: "diff_matches", expected: "malformed.patch" },
      project
    )).rejects.toMatchObject({ category: "task_invalid" });
    await expect(validateDiffMatchesAssertion(
      { type: "diff_matches", expected: "escape.patch" },
      project
    )).rejects.toMatchObject({ category: "task_invalid" });
  });

  it("returns assertion_error for missing runtime inputs rather than a false verdict", async () => {
    const fixture = await temporaryDirectory("assay-diff-error-fixture-");
    const workspace = await temporaryDirectory("assay-diff-error-workspace-");
    const project = await temporaryDirectory("assay-diff-error-project-");
    await writeTree(project, {
      "expected.patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    });

    const executionContext = {
      ...context(workspace, fixture, project),
      fixtureRoot: undefined
    } as unknown as AssertionExecutionContext;
    await expect(evaluateDeterministicAssertion({
      type: "diff_matches",
      expected: "expected.patch"
    }, executionContext, new AbortController().signal)).resolves.toMatchObject({
      verdict: "error",
      errorCategory: "assertion_error"
    });
  });
});
