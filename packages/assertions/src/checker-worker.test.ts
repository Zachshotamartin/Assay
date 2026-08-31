import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateCheckerAssertion,
  createSystemDeadlineScheduler,
  validateAssertionLayerOrder,
  validateCheckerModule,
  type CheckerAssertionSpec,
  type CheckerExecutionContext
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

async function checkerProject(
  files: Readonly<Record<string, string>>
): Promise<{ readonly project: string; readonly workspace: string }> {
  const project = await temporaryDirectory("assay-checker-project-");
  const workspace = await temporaryDirectory("assay-checker-workspace-");
  for (const [path, source] of Object.entries(files)) {
    const target = join(project, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  await writeFile(join(workspace, "value.txt"), "workspace value", "utf8");
  return { project, workspace };
}

function clock(): Clock {
  let value = 100;
  return {
    wallTime: () => "2026-08-30T00:00:00.000Z",
    monotonicMilliseconds: () => value++
  };
}

function executionContext(
  projectRoot: string,
  workspaceRoot: string,
  overrides: Partial<CheckerExecutionContext> = {}
): CheckerExecutionContext {
  return {
    projectRoot,
    workspaceRoot,
    task: Object.freeze({
      formatVersion: "1.0",
      id: "checker-task",
      title: "Checker task",
      tags: [],
      fixture: {},
      prompt: "check",
      toolset: {},
      sandbox: {},
      assertions: []
    }),
    trajectory: Object.freeze([{ type: "text_output", text: "done" }]),
    clock: clock(),
    deadlineScheduler: createSystemDeadlineScheduler(),
    ...overrides
  };
}

function spec(module: string, overrides: Partial<CheckerAssertionSpec> = {}): CheckerAssertionSpec {
  return {
    type: "checker",
    name: "checker fixture",
    module,
    timeout_ms: 2_000,
    memory_mb: 64,
    ...overrides
  };
}

const CHECKER_IMPORTS = `
import type { CheckerContext, CheckerVerdict } from "@assay/checker-api";
`;

describe("checker module static validation", () => {
  it("type-checks the check export and permits type-only API plus in-subtree relative imports", async () => {
    const { project } = await checkerProject({
      "checks/helper.ts": `export const expectation = "workspace value";`,
      "checks/pass.checker.ts": `${CHECKER_IMPORTS}
import { expectation } from "./helper.js";
export async function check(ctx: CheckerContext): Promise<CheckerVerdict> {
  const observed = await ctx.workspace.readText("value.txt");
  return { verdict: observed === expectation ? "pass" : "fail", observed, expectation };
}
`
    });

    const canonicalProject = await realpath(project);
    await expect(validateCheckerModule(spec("checks/pass.checker.ts"), project)).resolves.toMatchObject({
      modulePath: join(canonicalProject, "checks", "pass.checker.ts"),
      sourceFiles: [
        join(canonicalProject, "checks", "helper.ts"),
        join(canonicalProject, "checks", "pass.checker.ts")
      ]
    });
  });

  it("validates without executing top-level checker code", async () => {
    const { project } = await checkerProject({
      "checks/inert.checker.ts": `${CHECKER_IMPORTS}
throw new Error("validation executed checker code");
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  return { verdict: "pass", observed: "inert", expectation: "inert" };
}
`
    });
    await expect(validateCheckerModule(spec("checks/inert.checker.ts"), project)).resolves.toBeDefined();
  });

  it.each([
    ["Node builtin", `import { readFile } from "node:fs/promises";\n${CHECKER_IMPORTS}\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { await readFile("/etc/passwd"); return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["node:net", `import { createConnection } from "node:net";\n${CHECKER_IMPORTS}\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { createConnection({ host: "127.0.0.1", port: 1 }); return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["node:http", `import { get } from "node:http";\n${CHECKER_IMPORTS}\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { get("http://127.0.0.1/"); return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["runtime checker API import", `import { CheckerContext } from "@assay/checker-api";\nexport async function check(_ctx: CheckerContext) { return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["third-party package", `${CHECKER_IMPORTS}\nimport value from "some-package";\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { return { verdict: "pass", observed: String(value), expectation: "x" }; }`],
    ["dynamic import", `${CHECKER_IMPORTS}\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { await import("node:fs"); return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["require", `${CHECKER_IMPORTS}\ndeclare const require: (name: string) => unknown;\nexport async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { require("node:fs"); return { verdict: "pass", observed: "x", expectation: "x" }; }`]
  ])("rejects forbidden imports before execution: %s", async (_label, source) => {
    const { project } = await checkerProject({ "checks/forbidden.checker.ts": source });
    await expect(validateCheckerModule(spec("checks/forbidden.checker.ts"), project)).rejects.toMatchObject({
      category: "checker_invalid",
      code: "checker_invalid/import-restriction"
    });
  });

  it("rejects relative imports that leave the checker directory subtree", async () => {
    const { project } = await checkerProject({
      "outside.ts": `export const outside = true;`,
      "checks/escape.checker.ts": `${CHECKER_IMPORTS}
import { outside } from "../outside.js";
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  return { verdict: "pass", observed: String(outside), expectation: "true" };
}
`
    });
    await expect(validateCheckerModule(spec("checks/escape.checker.ts"), project)).rejects.toMatchObject({
      category: "checker_invalid",
      code: "checker_invalid/import-path-escape"
    });
  });

  it.each([
    ["missing export", `${CHECKER_IMPORTS}\nasync function check(_ctx: CheckerContext): Promise<CheckerVerdict> { return { verdict: "pass", observed: "x", expectation: "x" }; }`],
    ["wrong parameter", `export async function check(value: number): Promise<number> { return value; }`],
    ["syntax error", `export async function check( {`]
  ])("rejects an invalid check contract: %s", async (_label, source) => {
    const { project } = await checkerProject({ "checks/invalid.checker.ts": source });
    await expect(validateCheckerModule(spec("checks/invalid.checker.ts"), project)).rejects.toMatchObject({
      category: "checker_invalid"
    });
  });

  it("rejects checker module path escape before reading the target", async () => {
    const { project } = await checkerProject({});
    await expect(validateCheckerModule(spec("../outside.checker.ts"), project)).rejects.toMatchObject({
      category: "checker_invalid",
      code: "checker_invalid/path-escape"
    });
  });
});

describe("restricted checker worker", () => {
  it("returns pass and fail verdicts with workspace, trajectory, and bounded logs", async () => {
    const { project, workspace } = await checkerProject({
      "checks/verdict.checker.ts": `${CHECKER_IMPORTS}
export async function check(ctx: CheckerContext): Promise<CheckerVerdict> {
  const observed = await ctx.workspace.readText("value.txt");
  const events = ctx.trajectory.events();
  ctx.log("checked " + events.length + " event");
  return {
    verdict: ctx.task.id === "checker-task" && observed === "workspace value" ? "pass" : "fail",
    observed,
    expectation: "workspace value",
    details: { event_count: events.length }
  };
}
`,
      "checks/fail.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  return { verdict: "fail", observed: "FIFO", expectation: "LRU" };
}
`
    });
    const context = executionContext(project, workspace);

    const pass = await evaluateCheckerAssertion(spec("checks/verdict.checker.ts"), context, new AbortController().signal);
    const fail = await evaluateCheckerAssertion(spec("checks/fail.checker.ts"), context, new AbortController().signal);

    expect(pass).toMatchObject({
      type: "checker",
      target: "checker fixture",
      observed: "workspace value",
      expectation: "workspace value",
      verdict: "pass",
      durationMs: 1,
      details: { event_count: 1 },
      logs: ["checked 1 event"]
    });
    expect(fail).toMatchObject({ observed: "FIFO", expectation: "LRU", verdict: "fail" });
  });

  it.each([
    ["throw", `throw new Error("checker exploded");`],
    ["malformed", `return ({ verdict: "maybe", observed: 7, expectation: "x" } as unknown as CheckerVerdict);`]
  ])("classifies %s as assertion_error rather than failure", async (_label, body) => {
    const { project, workspace } = await checkerProject({
      "checks/error.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> { ${body} }
`
    });
    await expect(evaluateCheckerAssertion(
      spec("checks/error.checker.ts"),
      executionContext(project, workspace),
      new AbortController().signal
    )).resolves.toMatchObject({
      verdict: "error",
      errorCategory: "assertion_error"
    });
  });

  it("terminates a hung checker at its wall-clock limit as assertion_error", async () => {
    const { project, workspace } = await checkerProject({
      "checks/loop.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  for (;;) { /* bounded by the worker host */ }
}
`
    });
    const started = performance.now();
    const result = await evaluateCheckerAssertion(
      spec("checks/loop.checker.ts", { timeout_ms: 100 }),
      executionContext(project, workspace),
      new AbortController().signal
    );

    expect(result).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
    expect(result.message).toContain("timed out after 100 ms");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("terminates a checker that exceeds its worker memory limit", async () => {
    const { project, workspace } = await checkerProject({
      "checks/memory.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  const values: unknown[] = [];
  for (;;) values.push(new Array(100_000).fill({ payload: "memory" }));
}
`
    });
    const result = await evaluateCheckerAssertion(
      spec("checks/memory.checker.ts", { timeout_ms: 5_000, memory_mb: 32 }),
      executionContext(project, workspace),
      new AbortController().signal
    );

    expect(result).toMatchObject({ verdict: "error", errorCategory: "assertion_error" });
    expect(result.message).toMatch(/memory|heap|resource limit/iu);
  }, 10_000);

  it("freezes checker context, removes ambient environment access, and rejects workspace escapes", async () => {
    const { project, workspace } = await checkerProject({
      "checks/restricted.checker.ts": `${CHECKER_IMPORTS}
export async function check(ctx: CheckerContext): Promise<CheckerVerdict> {
  let mutation = "allowed";
  try { (ctx.task as { id: string }).id = "mutated"; } catch { mutation = "blocked"; }
  let escape = "allowed";
  try { await ctx.workspace.readText("../secret"); } catch { escape = "blocked"; }
  const processValue = (globalThis as { process?: unknown }).process;
  const fetchValue = (globalThis as { fetch?: unknown }).fetch;
  const observed = JSON.stringify({ mutation, escape, process: typeof processValue, fetch: typeof fetchValue });
  return {
    verdict: observed === '{"mutation":"blocked","escape":"blocked","process":"undefined","fetch":"undefined"}' ? "pass" : "fail",
    observed,
    expectation: "restricted"
  };
}
`
    });
    const task = {
      formatVersion: "1.0" as const,
      id: "checker-task",
      title: "Checker task",
      tags: [] as readonly string[],
      fixture: {},
      prompt: "check",
      toolset: {},
      sandbox: {},
      assertions: [] as readonly unknown[],
      nested: { value: 1 }
    };
    const result = await evaluateCheckerAssertion(
      spec("checks/restricted.checker.ts"),
      executionContext(project, workspace, { task }),
      new AbortController().signal
    );

    expect(result).toMatchObject({ verdict: "pass" });
    expect(task).toEqual({
      formatVersion: "1.0",
      id: "checker-task",
      title: "Checker task",
      tags: [],
      fixture: {},
      prompt: "check",
      toolset: {},
      sandbox: {},
      assertions: [],
      nested: { value: 1 }
    });
    await expect(readFile(join(workspace, "value.txt"), "utf8")).resolves.toBe("workspace value");
  });

  it("refuses a real loopback network attempt with zero connections", async () => {
    let connectionCount = 0;
    const sentinel = createServer((socket) => {
      connectionCount += 1;
      socket.destroy();
    });
    sentinel.listen(0, "127.0.0.1");
    await once(sentinel, "listening");
    const address = sentinel.address();
    if (address === null || typeof address === "string") {
      throw new Error("loopback sentinel did not bind a TCP port");
    }

    const { project, workspace } = await checkerProject({
      "checks/net-attempt.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  const network = globalThis as unknown as { fetch(input: string): Promise<unknown> };
  await network.fetch("http://127.0.0.1:${address.port}/checker-net-attempt");
  return { verdict: "pass", observed: "connected", expectation: "network must be unavailable" };
}
`
    });

    let result: Awaited<ReturnType<typeof evaluateCheckerAssertion>> | undefined;
    try {
      result = await evaluateCheckerAssertion(
        spec("checks/net-attempt.checker.ts"),
        executionContext(project, workspace),
        new AbortController().signal
      );
    } finally {
      const closed = once(sentinel, "close");
      sentinel.close();
      await closed;
    }

    expect(connectionCount).toBe(0);
    expect(result).toMatchObject({
      verdict: "error",
      errorCategory: "assertion_error",
      message: expect.stringMatching(/fetch|function/iu)
    });
  });

  it.each([
    ["Function", `Function("name", "return import(name)")`],
    ["indirect eval", `(0, eval)("(name) => import(name)")`],
    ["function constructor recovery", `(() => undefined).constructor("name", "return import(name)")`],
    ["async constructor recovery", `Object.getPrototypeOf(async () => undefined).constructor("name", "return import(name)")`]
  ])("blocks runtime-generated imports through %s", async (_label, loaderExpression) => {
    const { project, workspace } = await checkerProject({
      "checks/generated-import.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  const load = ${loaderExpression} as (name: string) => Promise<{
    readFile(path: string, encoding: string): Promise<string>;
  }>;
  const filesystem = await load("node:fs/promises");
  const observed = await filesystem.readFile("/etc/hosts", "utf8");
  return { verdict: "pass", observed, expectation: "host file must be inaccessible" };
}
`
    });

    await expect(evaluateCheckerAssertion(
      spec("checks/generated-import.checker.ts"),
      executionContext(project, workspace),
      new AbortController().signal
    )).resolves.toMatchObject({
      verdict: "error",
      errorCategory: "assertion_error",
      message: expect.stringMatching(/code generation|EvalError/iu)
    });
  });

  it("propagates cancellation without manufacturing an assertion result", async () => {
    const { project, workspace } = await checkerProject({
      "checks/cancel.checker.ts": `${CHECKER_IMPORTS}
export async function check(_ctx: CheckerContext): Promise<CheckerVerdict> {
  for (;;) { /* cancelled by parent */ }
}
`
    });
    const controller = new AbortController();
    const pending = evaluateCheckerAssertion(
      spec("checks/cancel.checker.ts", { timeout_ms: 5_000 }),
      executionContext(project, workspace),
      controller.signal
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("layer ordering", () => {
  it("accepts deterministic then checker then judge while preserving declaration order", () => {
    expect(validateAssertionLayerOrder([
      { type: "file_exists" },
      { type: "command_output" },
      { type: "checker" },
      { type: "checker" },
      { type: "judge" }
    ])).toEqual(["deterministic", "deterministic", "checker", "checker", "judge"]);
  });

  it("rejects the first out-of-place assertion with the stable task_invalid code", () => {
    expect(() => validateAssertionLayerOrder([
      { type: "file_exists" },
      { type: "judge" },
      { type: "checker" }
    ])).toThrow(expect.objectContaining({
      category: "task_invalid",
      code: "task_invalid/assertion-layer-order",
      assertionIndex: 2
    }));
  });
});
