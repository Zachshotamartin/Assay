import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASSERTION_OUTPUT_LIMIT_BYTES,
  createHostCommandRunner,
  createSystemDeadlineScheduler,
  evaluateDeterministicAssertion,
  evaluateDeterministicAssertions,
  validateDeterministicAssertion,
  validateJsonSchemaAssertion,
  type AssertionCommandRunner,
  type AssertionExecutionContext,
  type CommandExecutionRequest,
  type CommandExecutionResult,
  type DeadlineScheduler,
  type DeterministicAssertionSpec
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

function clock(step = 3): Clock {
  let monotonic = 10;
  return {
    wallTime: () => "2026-08-30T00:00:00.000Z",
    monotonicMilliseconds: () => {
      const current = monotonic;
      monotonic += step;
      return current;
    }
  };
}

const unusedRunner: AssertionCommandRunner = {
  run: async (): Promise<CommandExecutionResult> => {
    throw new Error("command runner must not be called");
  }
};

function context(
  workspaceRoot: string,
  projectRoot: string,
  overrides: Partial<AssertionExecutionContext> = {}
): AssertionExecutionContext {
  return {
    workspaceRoot,
    projectRoot,
    fixtureRoot: workspaceRoot,
    agentExitCode: 0,
    clock: clock(),
    commandRunner: unusedRunner,
    ...overrides
  };
}

describe("deterministic assertion engines", () => {
  it("evaluates exit_code as pass, fail, or assertion_error", async () => {
    const workspace = await temporaryDirectory("assay-assert-exit-");
    const spec = { type: "exit_code", equals: 0 } as const;

    await expect(evaluateDeterministicAssertion(
      spec,
      context(workspace, workspace),
      new AbortController().signal
    )).resolves.toMatchObject({
      type: "exit_code",
      target: "agent exit code",
      observed: 0,
      expectation: 0,
      verdict: "pass",
      durationMs: 3
    });
    await expect(evaluateDeterministicAssertion(
      spec,
      context(workspace, workspace, { agentExitCode: 9 }),
      new AbortController().signal
    )).resolves.toMatchObject({ observed: 9, verdict: "fail" });
    await expect(evaluateDeterministicAssertion(
      spec,
      context(workspace, workspace, { agentExitCode: null }),
      new AbortController().signal
    )).resolves.toMatchObject({
      verdict: "error",
      errorCategory: "assertion_error"
    });
  });

  it("evaluates tests_pass from exit status only and classifies runner faults", async () => {
    const workspace = await temporaryDirectory("assay-assert-tests-");
    const spec = { type: "tests_pass", command: ["npm", "test"] } as const;
    const outputs = [
      { status: "completed", exitCode: 0, stdout: "FAIL in log", stderr: "" },
      { status: "completed", exitCode: 1, stdout: "all tests passed", stderr: "" },
      { status: "spawn_error", message: "ENOENT" }
    ] as const;
    let index = 0;
    const runner: AssertionCommandRunner = {
      run: async () => outputs[index++] as CommandExecutionResult
    };

    const results = await Promise.all([
      evaluateDeterministicAssertion(spec, context(workspace, workspace, { commandRunner: runner }), new AbortController().signal),
      evaluateDeterministicAssertion(spec, context(workspace, workspace, { commandRunner: runner }), new AbortController().signal),
      evaluateDeterministicAssertion(spec, context(workspace, workspace, { commandRunner: runner }), new AbortController().signal)
    ]);
    expect(results.map(({ verdict }) => verdict)).toEqual(["pass", "fail", "error"]);
    expect(results[2]).toMatchObject({ errorCategory: "assertion_error" });
  });

  it("evaluates file_exists without following symlinks", async () => {
    const workspace = await temporaryDirectory("assay-assert-exists-");
    const project = await temporaryDirectory("assay-assert-project-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "value.txt"), "value", "utf8");
    await symlink("src/value.txt", join(workspace, "value-link"));

    const pass = await evaluateDeterministicAssertion(
      { type: "file_exists", path: "src/value.txt" },
      context(workspace, project),
      new AbortController().signal
    );
    const fail = await evaluateDeterministicAssertion(
      { type: "file_exists", path: "missing.txt" },
      context(workspace, project),
      new AbortController().signal
    );
    const linkAsAny = await evaluateDeterministicAssertion(
      { type: "file_exists", path: "value-link", kind: "any" },
      context(workspace, project),
      new AbortController().signal
    );
    const linkAsFile = await evaluateDeterministicAssertion(
      { type: "file_exists", path: "value-link", kind: "file" },
      context(workspace, project),
      new AbortController().signal
    );
    const error = await evaluateDeterministicAssertion(
      { type: "file_exists", path: "src/value.txt/child" },
      context(workspace, project),
      new AbortController().signal
    );

    expect(pass).toMatchObject({ observed: "file", expectation: "file", verdict: "pass" });
    expect(fail).toMatchObject({ observed: "absent", verdict: "fail" });
    expect(linkAsAny).toMatchObject({ observed: "symlink", verdict: "pass" });
    expect(linkAsFile).toMatchObject({ observed: "symlink", verdict: "fail" });
    expect(error).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
  });

  it("evaluates file_absent and reports filesystem evaluation errors", async () => {
    const workspace = await temporaryDirectory("assay-assert-absent-");
    await writeFile(join(workspace, "present"), "x", "utf8");

    const pass = await evaluateDeterministicAssertion(
      { type: "file_absent", path: "missing" },
      context(workspace, workspace),
      new AbortController().signal
    );
    const fail = await evaluateDeterministicAssertion(
      { type: "file_absent", path: "present" },
      context(workspace, workspace),
      new AbortController().signal
    );
    const error = await evaluateDeterministicAssertion(
      { type: "file_absent", path: "present/child" },
      context(workspace, workspace),
      new AbortController().signal
    );

    expect(pass).toMatchObject({ observed: "absent", verdict: "pass" });
    expect(fail).toMatchObject({ observed: "file", verdict: "fail" });
    expect(error).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
  });

  it("evaluates bounded strict-UTF-8 literal and regex file_contains matches", async () => {
    const workspace = await temporaryDirectory("assay-assert-contains-");
    await writeFile(join(workspace, "text.txt"), "\ufeffone fish\ntwo fish\nfish", "utf8");
    await writeFile(join(workspace, "invalid.txt"), Uint8Array.from([0xff, 0xfe]));

    const literal = await evaluateDeterministicAssertion(
      { type: "file_contains", path: "text.txt", literal: "fish", min_count: 3 },
      context(workspace, workspace),
      new AbortController().signal
    );
    const regex = await evaluateDeterministicAssertion(
      { type: "file_contains", path: "text.txt", regex: "(?:one|two) fish", min_count: 2 },
      context(workspace, workspace),
      new AbortController().signal
    );
    const invalidUtf8 = await evaluateDeterministicAssertion(
      { type: "file_contains", path: "invalid.txt", literal: "fish" },
      context(workspace, workspace),
      new AbortController().signal
    );
    const tooLarge = await evaluateDeterministicAssertion(
      { type: "file_contains", path: "text.txt", literal: "fish", max_bytes: 2 },
      context(workspace, workspace),
      new AbortController().signal
    );

    expect(literal).toMatchObject({ observed: { count: 3 }, verdict: "pass" });
    expect(regex).toMatchObject({ observed: { count: 2 }, verdict: "pass" });
    expect(invalidUtf8).toMatchObject({ observed: "not valid UTF-8", verdict: "fail" });
    expect(tooLarge).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
  });

  it("evaluates JSON Schema conformance with at most five stable errors", async () => {
    const project = await temporaryDirectory("assay-assert-json-project-");
    const workspace = await temporaryDirectory("assay-assert-json-workspace-");
    await mkdir(join(project, "schemas"));
    await writeFile(join(project, "schemas", "value.schema.json"), JSON.stringify({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "additionalProperties": false,
      "required": ["value"],
      "properties": { "value": { "type": "integer", "minimum": 2 } }
    }), "utf8");
    const spec = { type: "json_schema", path: "value.json", schema: "schemas/value.schema.json" } as const;

    await writeFile(join(workspace, "value.json"), "{\"value\":2}", "utf8");
    const pass = await evaluateDeterministicAssertion(spec, context(workspace, project), new AbortController().signal);
    await writeFile(join(workspace, "value.json"), "{\"value\":1,\"extra\":true}", "utf8");
    const fail = await evaluateDeterministicAssertion(spec, context(workspace, project), new AbortController().signal);
    const error = await evaluateDeterministicAssertion(
      { ...spec, schema: "schemas/missing.schema.json" },
      context(workspace, project),
      new AbortController().signal
    );

    expect(pass).toMatchObject({ verdict: "pass" });
    expect(fail.verdict).toBe("fail");
    expect(Array.isArray(fail.observed)).toBe(true);
    expect((fail.observed as readonly unknown[]).length).toBeLessThanOrEqual(5);
    expect(error).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
  });

  it("precompiles local JSON Schemas during validation without evaluating a target", async () => {
    const project = await temporaryDirectory("assay-assert-json-preflight-");
    await mkdir(join(project, "schemas"));
    await writeFile(join(project, "schemas", "valid.json"), JSON.stringify({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object"
    }), "utf8");
    await writeFile(join(project, "schemas", "remote.json"), JSON.stringify({
      "$ref": "https://example.invalid/remote.json"
    }), "utf8");
    await writeFile(join(project, "schemas", "malformed.json"), "{", "utf8");

    await expect(validateJsonSchemaAssertion({
      type: "json_schema",
      path: "result.json",
      schema: "schemas/valid.json"
    }, project)).resolves.toBeUndefined();
    await expect(validateJsonSchemaAssertion({
      type: "json_schema",
      path: "result.json",
      schema: "schemas/remote.json"
    }, project)).rejects.toMatchObject({ category: "task_invalid" });
    await expect(validateJsonSchemaAssertion({
      type: "json_schema",
      path: "result.json",
      schema: "schemas/malformed.json"
    }, project)).rejects.toMatchObject({ category: "task_invalid" });
  });

  it("evaluates command_output matchers independently of exit status", async () => {
    const workspace = await temporaryDirectory("assay-assert-output-");
    const executions = [
      { status: "completed", exitCode: 9, stdout: "v1.2.3\n", stderr: "warning" },
      { status: "completed", exitCode: 0, stdout: "different", stderr: "" },
      { status: "output_limit", stream: "stdout", limitBytes: ASSERTION_OUTPUT_LIMIT_BYTES }
    ] as const;
    let index = 0;
    const runner: AssertionCommandRunner = {
      run: async () => executions[index++] as CommandExecutionResult
    };
    const commandContext = context(workspace, workspace, { commandRunner: runner });
    const signal = new AbortController().signal;

    const pass = await evaluateDeterministicAssertion(
      { type: "command_output", command: ["version"], regex: "^v1\\.[0-9]+\\.[0-9]+$" },
      commandContext,
      signal
    );
    const fail = await evaluateDeterministicAssertion(
      { type: "command_output", command: ["version"], contains: "v1" },
      commandContext,
      signal
    );
    const error = await evaluateDeterministicAssertion(
      { type: "command_output", command: ["version"], contains: "v1" },
      commandContext,
      signal
    );

    expect(pass).toMatchObject({ observed: "v1.2.3", verdict: "pass" });
    expect(fail).toMatchObject({ observed: "different", verdict: "fail" });
    expect(error).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
  });

  it("preserves declared order and evaluates every deterministic assertion", async () => {
    const workspace = await temporaryDirectory("assay-assert-order-");
    await writeFile(join(workspace, "value"), "x", "utf8");
    const specs: readonly DeterministicAssertionSpec[] = [
      { type: "file_exists", path: "value" },
      { type: "exit_code", equals: 9 },
      { type: "file_absent", path: "missing" },
      { type: "file_contains", path: "value", literal: "x" }
    ];

    const results = await evaluateDeterministicAssertions(
      specs,
      context(workspace, workspace, { agentExitCode: 0 }),
      new AbortController().signal
    );

    expect(results.map(({ type }) => type)).toEqual([
      "file_exists",
      "exit_code",
      "file_absent",
      "file_contains"
    ]);
    expect(results.map(({ verdict }) => verdict)).toEqual(["pass", "fail", "pass", "pass"]);
    for (const result of results) {
      expect(result).toEqual(expect.objectContaining({
        type: expect.any(String),
        target: expect.any(String),
        observed: expect.anything(),
        expectation: expect.anything(),
        verdict: expect.stringMatching(/^(?:pass|fail|error)$/u),
        durationMs: expect.any(Number)
      }));
    }
  });
});

describe("host command boundary", () => {
  it("executes argv without shell interpretation in a bound fresh workspace", async () => {
    const workspace = await temporaryDirectory("assay-assert-host-command-");
    const runner = await createHostCommandRunner({
      workspaceRoot: workspace,
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      deadlineScheduler: createSystemDeadlineScheduler()
    });
    const request: CommandExecutionRequest = {
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(touch should-not-exist)"],
      cwd: workspace,
      timeoutMs: 2_000,
      maxOutputBytes: ASSERTION_OUTPUT_LIMIT_BYTES
    };

    await expect(runner.run(request, new AbortController().signal)).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "$(touch should-not-exist)",
      stderr: ""
    });
    await expect(evaluateDeterministicAssertion(
      { type: "file_absent", path: "should-not-exist" },
      context(workspace, workspace),
      new AbortController().signal
    )).resolves.toMatchObject({ verdict: "pass" });
  });

  it("bounds output, classifies spawn failure, and honors cancellation", async () => {
    const workspace = await temporaryDirectory("assay-assert-host-bounds-");
    const runner = await createHostCommandRunner({
      workspaceRoot: workspace,
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      deadlineScheduler: createSystemDeadlineScheduler()
    });
    const signal = new AbortController().signal;

    await expect(runner.run({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(64))"],
      cwd: workspace,
      timeoutMs: 2_000,
      maxOutputBytes: 32
    }, signal)).resolves.toEqual({ status: "output_limit", stream: "stdout", limitBytes: 32 });
    await expect(runner.run({
      argv: ["assay-command-that-does-not-exist"],
      cwd: workspace,
      timeoutMs: 2_000,
      maxOutputBytes: 32
    }, signal)).resolves.toMatchObject({ status: "spawn_error" });

    const controller = new AbortController();
    controller.abort();
    await expect(runner.run({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      cwd: workspace,
      timeoutMs: 2_000,
      maxOutputBytes: 32
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces command timeouts through the injected deadline scheduler", async () => {
    const workspace = await temporaryDirectory("assay-assert-host-deadline-");
    let fireDeadline: (() => void) | undefined;
    let cancelled = false;
    const deadlineScheduler: DeadlineScheduler = {
      schedule: (_delayMs, callback) => {
        fireDeadline = callback;
        return { cancel: () => { cancelled = true; } };
      }
    };
    const runner = await createHostCommandRunner({
      workspaceRoot: workspace,
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      deadlineScheduler
    });
    const pending = runner.run({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: workspace,
      timeoutMs: 1_234,
      maxOutputBytes: 32
    }, new AbortController().signal);
    while (fireDeadline === undefined) {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
    }
    fireDeadline();

    await expect(pending).resolves.toEqual({ status: "timeout", timeoutMs: 1_234 });
    expect(cancelled).toBe(true);
  });
});

describe("assertion validation boundary", () => {
  it.each([
    { type: "file_exists", path: "../host-secret" },
    { type: "file_absent", path: "/etc/passwd" },
    { type: "file_contains", path: "safe", literal: "x", max_bytes: 0 },
    { type: "tests_pass", command: [], timeout_ms: 1000 },
    { type: "tests_pass", command: ["node"], cwd: "../../outside", timeout_ms: 1000 },
    { type: "command_output", command: ["node"], equals: "x", contains: "x" },
    { type: "file_contains", path: "safe", regex: "(a+)+$" },
    { type: "file_contains", path: "safe", regex: "^(a|aa)+$" }
  ])("rejects invalid or escaping specs before effects: $type", (spec) => {
    expect(() => validateDeterministicAssertion(spec)).toThrow(expect.objectContaining({
      category: "task_invalid"
    }));
  });
});
