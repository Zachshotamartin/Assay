import { describe, expect, it } from "vitest";

import { executeCli, parseCliInvocation } from "./cli.js";

function capture(): {
  readonly io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };
  readonly stdout: string[];
  readonly stderr: string[];
} {
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

describe("R1 CLI surface", () => {
  it("prints the package version without running a product command", async () => {
    const output = capture();

    await expect(executeCli(["--version"], output.io)).resolves.toBe(0);
    expect(output.stdout).toEqual(["assay 0.0.0\n"]);
    expect(output.stderr).toEqual([]);
  });

  it("prints help for the implemented R1 commands only", async () => {
    const output = capture();

    await expect(executeCli(["--help"], output.io)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("assay validate [paths]");
    expect(output.stdout.join("")).toContain("assay run <suite> --variant <name>");
    expect(output.stdout.join("")).not.toContain("assay compare");
    expect(output.stderr).toEqual([]);
  });

  it("rejects unknown commands and flags with invalid_invocation exit 4", async () => {
    const output = capture();

    await expect(executeCli(["compare"], output.io)).resolves.toBe(4);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toContain("invalid_invocation");

    const unknownFlag = capture();
    await expect(executeCli([
      "run", "suite.yaml", "--variant", "baseline", "--surprise"
    ], unknownFlag.io)).resolves.toBe(4);
    expect(unknownFlag.stderr.join("")).toContain("--surprise");
  });

  it("parses validate paths without executing anything", () => {
    expect(parseCliInvocation(["validate", "tasks/a.task.yaml", "suites/core.suite.yaml"]))
      .toEqual({
        command: "validate",
        paths: ["tasks/a.task.yaml", "suites/core.suite.yaml"]
      });
  });

  it("parses the exact assay run flag contract", () => {
    expect(parseCliInvocation([
      "run",
      "suites/core.suite.yaml",
      "--variant", "baseline",
      "-n", "7",
      "--adapter", "simulated",
      "--seed", "42",
      "--dry-run",
      "--unsafe-host-exec"
    ])).toEqual({
      command: "run",
      suitePath: "suites/core.suite.yaml",
      variant: "baseline",
      runsPerTask: 7,
      adapter: "simulated",
      seed: 42,
      dryRun: true,
      unsafeHostExec: true
    });
  });

  it.each([
    ["missing suite", ["run", "--variant", "baseline"]],
    ["missing variant", ["run", "suite.yaml"]],
    ["missing value", ["run", "suite.yaml", "--variant"]],
    ["invalid n", ["run", "suite.yaml", "--variant", "baseline", "-n", "0"]],
    ["invalid seed", ["run", "suite.yaml", "--variant", "baseline", "--seed", "4294967296"]],
    ["duplicate flag", ["run", "suite.yaml", "--variant", "a", "--variant", "b"]],
    ["extra positional", ["run", "suite.yaml", "other.yaml", "--variant", "a"]]
  ] as const)("rejects %s before command effects", async (_label, argv) => {
    const output = capture();
    await expect(executeCli(argv, output.io)).resolves.toBe(4);
    expect(output.stderr.join("")).toContain("invalid_invocation");
  });
});
