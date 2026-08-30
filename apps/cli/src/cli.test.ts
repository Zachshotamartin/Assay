import { describe, expect, it } from "vitest";

import { executeCli } from "./cli.js";

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

describe("R0 CLI bootstrap surface", () => {
  it("prints the package version without loading product commands", () => {
    const output = capture();

    expect(executeCli(["--version"], output.io)).toBe(0);
    expect(output.stdout).toEqual(["assay 0.0.0\n"]);
    expect(output.stderr).toEqual([]);
  });

  it("prints help limited to the implemented bootstrap flags", () => {
    const output = capture();

    expect(executeCli(["--help"], output.io)).toBe(0);
    expect(output.stdout).toEqual([
      "Usage: assay [--help] [--version]\n\nAssay implementation bootstrap; product commands are not available yet.\n"
    ]);
    expect(output.stderr).toEqual([]);
  });

  it("rejects every not-yet-implemented command", () => {
    const output = capture();

    expect(executeCli(["run"], output.io)).toBe(4);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      "assay: product commands are not available yet (invalid_invocation)\n"
    ]);
  });
});
