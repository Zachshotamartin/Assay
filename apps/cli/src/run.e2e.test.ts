import { readdir, readFile, rm, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { simulatedAdapterCommand } from "@assay/adapter-simulated";
import {
  createRunId,
  createTaskRunId,
  type Clock,
  type IdSource,
  type RunId,
  type TaskRunId
} from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli, type CliIo, type CliRuntime } from "./cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "assay-cli-e2e-"));
  roots.push(root);
  return root;
}

function output(): {
  readonly io: CliIo;
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

function sequence<T extends string>(values: readonly T[]): IdSource<T> {
  let index = 0;
  return {
    next() {
      const value = values[index];
      if (value === undefined) throw new Error("test identifier source exhausted");
      index += 1;
      return value;
    }
  };
}

function runtime(
  root: string,
  overrides: Partial<CliRuntime> = {}
): CliRuntime {
  let monotonic = 10_000;
  const clock: Clock = {
    wallTime: () => "2026-08-30T12:00:00.000Z",
    monotonicMilliseconds: () => monotonic++
  };
  const runIds = Array.from({ length: 8 }, (_, index) =>
    createRunId(`01890f70-6c50-7cc8-b2cb-${String(index + 1).padStart(12, "0")}`));
  const taskRunIds = Array.from({ length: 32 }, (_, index) =>
    createTaskRunId(`01890f70-6c50-7dd8-b2cb-${String(index + 1).padStart(12, "0")}`));
  let event = 0;
  return {
    projectRoot: root,
    environment: {},
    clock,
    runIdSource: sequence<RunId>(runIds),
    taskRunIdSource: sequence<TaskRunId>(taskRunIds),
    eventIdSource: { next: () => `event-${String(++event).padStart(6, "0")}` },
    processId: process.pid,
    signal: new AbortController().signal,
    adapterCommandFor: () => simulatedAdapterCommand(),
    ...overrides
  };
}

interface FixtureOptions {
  readonly assertion?: Readonly<Record<string, unknown>>;
  readonly includeChecker?: boolean;
  readonly config?: string;
}

async function writeProject(root: string, options: FixtureOptions = {}): Promise<void> {
  await mkdir(join(root, "fixtures", "repo"), { recursive: true });
  await mkdir(join(root, "checks"), { recursive: true });
  await writeFile(join(root, "fixtures", "repo", "README.md"), "deterministic fixture\n", "utf8");

  const assertions: Readonly<Record<string, unknown>>[] = [
    options.assertion ?? { type: "file_exists", path: "README.md" }
  ];
  if (options.includeChecker === true) {
    assertions.push({ type: "checker", module: "checks/pass.checker.ts" });
    await writeFile(join(root, "checks", "pass.checker.ts"), `
import type { CheckerContext, CheckerVerdict } from "@assay/checker-api";
export async function check(ctx: CheckerContext): Promise<CheckerVerdict> {
  const observed = await ctx.workspace.readText("README.md");
  return {
    verdict: observed === "deterministic fixture\\n" ? "pass" : "fail",
    observed,
    expectation: "deterministic fixture\\n"
  };
}
`, "utf8");
  }

  await writeFile(join(root, "basic.task.yaml"), JSON.stringify({
    format_version: "1.0",
    id: "basic-task",
    title: "Basic deterministic task",
    fixture: { path: "fixtures/repo" },
    prompt: "Inspect the fixture and finish deterministically.",
    toolset: { catalog: "simulated/1" },
    sandbox: {
      image: `synthetic@sha256:${"0".repeat(64)}`,
      network: "none",
      timeout_ms: 10_000
    },
    assertions
  }), "utf8");
  await writeFile(join(root, "core.suite.yaml"), JSON.stringify({
    format_version: "1.0",
    id: "core-suite",
    title: "Core suite",
    include: ["basic.task.yaml"],
    variants: {
      baseline: { adapter: "simulated", model: "synthetic/scripted-v1" }
    }
  }), "utf8");
  if (options.config !== undefined) {
    await writeFile(join(root, "assay.config.yaml"), options.config, "utf8");
  }
}

function databaseRows(root: string, storePath = ".assay"): {
  readonly runs: readonly Readonly<Record<string, unknown>>[];
  readonly taskRuns: readonly Readonly<Record<string, unknown>>[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
} {
  const database = new DatabaseSync(join(root, storePath, "assay.db"));
  const runs = database.prepare("SELECT record_json FROM runs ORDER BY run_id").all()
    .map((row) => JSON.parse((row as { readonly record_json: string }).record_json) as Readonly<Record<string, unknown>>);
  const taskRuns = database.prepare("SELECT record_json FROM task_runs ORDER BY task_run_id").all()
    .map((row) => JSON.parse((row as { readonly record_json: string }).record_json) as Readonly<Record<string, unknown>>);
  const events = database.prepare("SELECT event_json FROM events ORDER BY sequence").all()
    .map((row) => JSON.parse((row as { readonly event_json: string }).event_json) as Readonly<Record<string, unknown>>);
  database.close();
  return { runs, taskRuns, events };
}

async function allFileBytes(directory: string): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(await readFile(target));
    }
  };
  await visit(directory);
  return output;
}

describe("R1.13 validate and run integration", () => {
  it("validates tasks, suites, and checker modules without execution or store writes", async () => {
    const root = await projectRoot();
    await writeProject(root, { includeChecker: true });
    let adapterResolutions = 0;
    const capture = output();

    const code = await executeCli(["validate", "core.suite.yaml"], capture.io, runtime(root, {
      adapterCommandFor: () => {
        adapterResolutions += 1;
        throw new Error("validation tried to construct an adapter");
      }
    }));

    expect(code).toBe(0);
    expect(capture.stdout).toEqual(["Validated 1 suite, 1 task, and 1 checker.\n"]);
    expect(capture.stderr).toEqual([]);
    expect(adapterResolutions).toBe(0);
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recursively validates a directory corpus in deterministic path order", async () => {
    const root = await projectRoot();
    await writeProject(root, { includeChecker: true });
    const capture = output();

    const code = await executeCli(["validate", "."], capture.io, runtime(root));

    expect(code).toBe(0);
    expect(capture.stdout).toEqual(["Validated 1 suite, 1 task, and 1 checker.\n"]);
    expect(capture.stderr).toEqual([]);
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves CLI over env over file config and emits a canonical dry-run with zero effects", async () => {
    const root = await projectRoot();
    await writeProject(root, {
      config: "configVersion: 1\nrunsPerTask: 3\ndefaultAdapter: adapter-simulated\n"
    });
    let adapterResolutions = 0;
    const capture = output();

    const code = await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1", "--seed", "42", "--dry-run"
    ], capture.io, runtime(root, {
      environment: { ASSAY_RUNS_PER_TASK: "2" },
      adapterCommandFor: () => {
        adapterResolutions += 1;
        throw new Error("dry-run tried to construct an adapter");
      }
    }));

    expect(code).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(adapterResolutions).toBe(0);
    expect(capture.stdout).toHaveLength(1);
    const plan = JSON.parse(capture.stdout[0]!) as Readonly<Record<string, unknown>>;
    expect(plan).toMatchObject({
      command: "run",
      dryRun: true,
      variant: "baseline",
      runsPerTask: 1,
      rootSeed: 42,
      adapter: "adapter-simulated",
      estimatedSpendCeilingUsd: 0,
      isolation: "unsafe_host"
    });
    expect(plan["tasks"]).toEqual([
      expect.objectContaining({ id: "basic-task", repetitions: 1 })
    ]);
    expect(capture.stdout[0]).toBe(`${JSON.stringify(plan)}\n`);
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the simulated adapter twice, evaluates assertions, and persists synthetic evidence", async () => {
    const root = await projectRoot();
    await writeProject(root);
    const capture = output();

    const code = await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "2", "--seed", "7"
    ], capture.io, runtime(root));

    expect(code).toBe(0);
    expect(capture.stderr.join("")).toContain("UNSAFE HOST EXECUTION");
    expect(capture.stdout.join("")).toMatch(/2 passed, 0 failed, 0 errors/u);
    const stored = databaseRows(root);
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0]).toMatchObject({
      variant: "baseline",
      adapterId: "adapter-simulated",
      modelId: "synthetic/scripted-v1",
      seed: 7,
      runsPerTask: 2,
      isolation: "unsafe_host"
    });
    expect(stored.taskRuns).toHaveLength(2);
    expect(stored.taskRuns).toEqual(stored.taskRuns.map((record) => expect.objectContaining({
      taskId: "basic-task",
      state: "completed",
      outcome: "pass",
      errorCategory: null,
      usage: expect.objectContaining({
        inputTokens: 22,
        outputTokens: 8,
        reconciliation: "synthetic",
        providerReportedCostUsd: 0
      })
    })));
    expect(stored.events.map((event) => event["type"])).toEqual(expect.arrayContaining([
      "RunPlanned", "FixtureMaterialized", "AdapterHandshake", "WorkspaceSnapshotTaken",
      "AssertionEvaluated", "TaskRunCompleted", "SandboxDestroyed", "SuiteCompleted"
    ]));
  });

  it("returns task-failure exit 1 without misclassifying the healthy harness", async () => {
    const root = await projectRoot();
    await writeProject(root, { assertion: { type: "file_absent", path: "README.md" } });
    const capture = output();

    const code = await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1", "--seed", "9"
    ], capture.io, runtime(root));

    expect(code).toBe(1);
    expect(capture.stdout.join("")).toMatch(/0 passed, 1 failed, 0 errors/u);
    expect(databaseRows(root).taskRuns[0]).toMatchObject({
      state: "completed",
      outcome: "fail",
      errorCategory: null
    });
  });

  it("requires explicit unsafe-host authorization before command assertions execute", async () => {
    const root = await projectRoot();
    await writeProject(root, {
      assertion: { type: "tests_pass", command: [process.execPath, "-e", "process.exit(0)"] }
    });
    const denied = output();

    expect(await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1"
    ], denied.io, runtime(root))).toBe(4);
    expect(denied.stderr.join("")).toContain("--unsafe-host-exec");
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });

    const allowed = output();
    expect(await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1", "--unsafe-host-exec"
    ], allowed.io, runtime(root))).toBe(0);
    expect(databaseRows(root).taskRuns[0]).toMatchObject({ outcome: "pass" });
  });

  it("maps unavailable adapters to infrastructure exit 5 before creating a store", async () => {
    const root = await projectRoot();
    await writeProject(root);
    const capture = output();

    const code = await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "--adapter", "missing-adapter"
    ], capture.io, runtime(root));

    expect(code).toBe(5);
    expect(capture.stderr.join("")).toContain("adapter_unavailable");
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps cancellation to exit 6", async () => {
    const root = await projectRoot();
    await writeProject(root);
    const controller = new AbortController();
    controller.abort();
    const capture = output();

    const code = await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1"
    ], capture.io, runtime(root, { signal: controller.signal }));

    expect(code).toBe(6);
    expect(capture.stderr.join("")).toContain("cancelled");
  });

  it("redacts a credential split across adapter frames before any store byte is written", async () => {
    const root = await projectRoot();
    await writeProject(root);
    const first = "sk-proj-SYNTHETIC0123";
    const second = "456789abcdefghijklmnopqrstuv";
    const scenarioPath = join(root, "split-secret.scenario.json");
    await writeFile(scenarioPath, JSON.stringify({
      scenario_version: 1,
      steps: [
        { emit: { type: "session_started", sessionId: "secret-session" } },
        { emit: { type: "text_output", text: first } },
        { emit: { type: "text_output", text: second } },
        { emit: { type: "run_completed", summary: "done" } }
      ]
    }), "utf8");
    const capture = output();

    expect(await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1"
    ], capture.io, runtime(root, {
      adapterCommandFor: () => simulatedAdapterCommand({ scenarioPath })
    }))).toBe(0);

    const persisted = Buffer.concat((await allFileBytes(join(root, ".assay"))).map((bytes) => Buffer.from(bytes)));
    expect(persisted.includes(Buffer.from(first))).toBe(false);
    expect(persisted.includes(Buffer.from(second))).toBe(false);
    expect(persisted.includes(Buffer.from(`${first}${second}`))).toBe(false);
    expect(capture.stdout.join("") + capture.stderr.join("")).not.toContain(first);
    expect(capture.stdout.join("") + capture.stderr.join("")).not.toContain(second);
  });

  it("uses the configured store path in the composed run", async () => {
    const root = await projectRoot();
    await writeProject(root, { config: "configVersion: 1\nstorePath: state/evidence\n" });
    const capture = output();

    expect(await executeCli([
      "run", "core.suite.yaml", "--variant", "baseline", "-n", "1"
    ], capture.io, runtime(root))).toBe(0);

    expect(databaseRows(root, "state/evidence").taskRuns).toHaveLength(1);
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
