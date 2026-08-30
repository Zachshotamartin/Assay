import { PassThrough } from "node:stream";

import {
  createTaskId,
  createTaskRunId,
  type AssayErrorCategory
} from "@assay/contracts";
import { describe, expect, it } from "vitest";

import {
  HANDSHAKE_DEADLINE_MS,
  TERMINAL_EXIT_DEADLINE_MS,
  TERMINATION_GRACE_MS,
  superviseAdapter,
  type AdapterCaptureRedactor,
  type AdapterChildProcess,
  type AdapterProcessExit,
  type AdapterScheduler,
  type ScheduledCallback,
  type SpawnAdapterProcess
} from "./supervisor.js";
import type { AdapterRunSpec } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const HANDSHAKE = {
  type: "handshake",
  seq: 1,
  contract: "assay-adapter/1",
  adapter: { id: "adapter-simulated", version: "1.0.0" },
  tier: "full",
  model: { provider: "synthetic", model: "scripted-v1", family: "synthetic" },
  tool_catalog: [
    { name: "read_file", semantic_class: "read" },
    { name: "write_file", semantic_class: "write" },
    { name: "run_command", semantic_class: "execute" }
  ],
  capabilities: {
    usage_reporting: true,
    cost_reporting: false,
    streaming_text: true
  }
} as const;

const TS = "2026-01-02T03:04:05.006Z";

function event(type: string, seq: number, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type, seq, ts: TS, ...payload })}\n`;
}

const RUN_SPEC: AdapterRunSpec = {
  taskId: createTaskId("fix-null-deref"),
  taskRunId: createTaskRunId("018f0f5e-7b3c-7def-8abc-0123456789ab"),
  prompt: "Fix the null dereference.",
  workspacePath: "/workspace",
  seed: "5f2a9c01d4e8b7a3",
  env: { TASK_DECLARED_VAR: "value" },
  limits: { wallClockMs: 600_000 },
  budgetsAdvisory: { totalTokens: 200_000, toolCalls: 100, usdMicros: 500_000 }
};

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll("sk-secret-value", "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)])
    );
  }
  return value;
}

const REDACTOR: AdapterCaptureRedactor = {
  redactJson: redactDeep,
  redactBytes: (bytes) => decoder.decode(bytes).replaceAll("sk-secret-value", "[REDACTED]")
};

class ManualScheduler implements AdapterScheduler {
  readonly callbacks: Array<{
    readonly delayMs: number;
    readonly callback: () => void;
    cancelled: boolean;
    fired: boolean;
  }> = [];

  schedule(delayMs: number, callback: () => void): ScheduledCallback {
    const entry = { delayMs, callback, cancelled: false, fired: false };
    this.callbacks.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }

  active(delayMs: number): typeof this.callbacks {
    return this.callbacks.filter((entry) =>
      entry.delayMs === delayMs && !entry.cancelled && !entry.fired
    );
  }

  fire(delayMs: number): void {
    const entry = this.active(delayMs)[0];
    if (entry === undefined) {
      throw new Error(`no active ${delayMs} ms callback`);
    }
    entry.fired = true;
    entry.callback();
  }
}

class FakeChild implements AdapterChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinWrites: string[] = [];
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = [];
  stdinClosed = false;
  exitOnTerm = true;
  #resolveExit!: (exit: AdapterProcessExit) => void;
  readonly exit = new Promise<AdapterProcessExit>((resolve) => {
    this.#resolveExit = resolve;
  });
  #finished = false;

  readonly stdin = {
    write: (value: string): void => {
      this.stdinWrites.push(value);
    }
  };

  emitStdout(value: string | Uint8Array): void {
    this.stdout.write(typeof value === "string" ? encoder.encode(value) : value);
  }

  emitStderr(value: string): void {
    this.stderr.write(encoder.encode(value));
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdout.end();
    this.stderr.end();
    this.#resolveExit({ code, signal });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.exitOnTerm) {
      this.finish(null, "SIGTERM");
    }
    return true;
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function harness(child: FakeChild, scheduler = new ManualScheduler()): {
  readonly scheduler: ManualScheduler;
  readonly spawnCalls: Array<{ argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }>;
  readonly run: ReturnType<typeof superviseAdapter>;
} {
  const spawnCalls: Array<{
    argv: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  }> = [];
  const spawn: SpawnAdapterProcess = (argv, options) => {
    spawnCalls.push({ argv, cwd: options.cwd, env: options.env });
    return child;
  };
  return {
    scheduler,
    spawnCalls,
    run: superviseAdapter({
      command: ["node", "adapter.js"],
      spec: RUN_SPEC,
      cwd: "/workspace",
      env: { LANG: "C.UTF-8" },
      redactor: REDACTOR,
      scheduler,
      spawn
    })
  };
}

async function emitHandshake(child: FakeChild): Promise<void> {
  child.emitStdout(`${JSON.stringify(HANDSHAKE)}\n`);
  await settle();
}

function emitHappy(child: FakeChild, terminal: "run_completed" | "run_failed" = "run_completed"): void {
  child.emitStdout(event("session_started", 2, { session_id: "session-1" }));
  child.emitStdout(
    terminal === "run_completed"
      ? event("run_completed", 3, { summary: "done" })
      : event("run_failed", 3, { category: "agent_gave_up", message: "stopped" })
  );
}

function expectErrorCategory(
  result: Awaited<ReturnType<typeof superviseAdapter>>,
  category: AssayErrorCategory
): void {
  expect(result).toMatchObject({ status: "error", errorCategory: category });
}

describe("adapter supervisor lifecycle", () => {
  it("pins all three externally observable deadlines", () => {
    expect(HANDSHAKE_DEADLINE_MS).toBe(10_000);
    expect(TERMINAL_EXIT_DEADLINE_MS).toBe(5_000);
    expect(TERMINATION_GRACE_MS).toBe(5_000);
  });

  it("appends one flag, validates the handshake, then writes one run_spec without closing stdin", async () => {
    const child = new FakeChild();
    const { run, spawnCalls, scheduler } = harness(child);
    expect(spawnCalls).toEqual([
      { argv: ["node", "adapter.js", "--assay-adapter"], cwd: "/workspace", env: { LANG: "C.UTF-8" } }
    ]);
    expect(scheduler.active(HANDSHAKE_DEADLINE_MS)).toHaveLength(1);
    expect(child.stdinWrites).toEqual([]);

    await emitHandshake(child);
    expect(child.stdinWrites).toHaveLength(1);
    expect(JSON.parse(child.stdinWrites[0] as string)).toMatchObject({
      type: "run_spec",
      contract: "assay-adapter/1",
      seed: "5f2a9c01d4e8b7a3"
    });
    expect(child.stdinClosed).toBe(false);
    expect(scheduler.active(HANDSHAKE_DEADLINE_MS)).toHaveLength(0);

    emitHappy(child);
    await settle();
    expect(scheduler.active(TERMINAL_EXIT_DEADLINE_MS)).toHaveLength(1);
    child.finish(0);
    await expect(run).resolves.toMatchObject({
      status: "completed",
      errorCategory: null,
      incomplete: false,
      malformedFrameCount: 0,
      events: [
        { type: "session_started", seq: 2 },
        { type: "run_completed", seq: 3 }
      ]
    });
  });

  it("accepts run_failed as terminal evidence only when followed by exit 0", async () => {
    const clean = new FakeChild();
    const cleanHarness = harness(clean);
    await emitHandshake(clean);
    emitHappy(clean, "run_failed");
    clean.finish(0);
    await expect(cleanHarness.run).resolves.toMatchObject({ status: "failed", errorCategory: null });

    const nonzero = new FakeChild();
    const nonzeroHarness = harness(nonzero);
    await emitHandshake(nonzero);
    emitHappy(nonzero, "run_failed");
    nonzero.finish(1);
    expectErrorCategory(await nonzeroHarness.run, "adapter_protocol_error");
  });

  it("rejects unknown contract majors before writing the run spec", async () => {
    const child = new FakeChild();
    const { run } = harness(child);
    child.emitStdout(`${JSON.stringify({ ...HANDSHAKE, contract: "assay-adapter/2" })}\n`);
    const result = await run;
    expectErrorCategory(result, "adapter_nonconformant");
    expect(child.stdinWrites).toEqual([]);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("times out a silent handshake at exactly 10 seconds and escalates after exactly 5 seconds", async () => {
    const child = new FakeChild();
    child.exitOnTerm = false;
    const { run, scheduler } = harness(child);
    scheduler.fire(HANDSHAKE_DEADLINE_MS);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(scheduler.active(TERMINATION_GRACE_MS)).toHaveLength(1);
    scheduler.fire(TERMINATION_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.finish(null, "SIGKILL");
    expectErrorCategory(await run, "adapter_protocol_error");
  });

  it("enforces the run wall clock through the injected scheduler", async () => {
    const child = new FakeChild();
    const { run, scheduler } = harness(child);
    await emitHandshake(child);
    expect(scheduler.active(RUN_SPEC.limits.wallClockMs)).toHaveLength(1);
    scheduler.fire(RUN_SPEC.limits.wallClockMs);
    expectErrorCategory(await run, "sandbox_timeout");
  });

  it("requires exit within 5 seconds after a terminal frame", async () => {
    const child = new FakeChild();
    const { run, scheduler } = harness(child);
    await emitHandshake(child);
    emitHappy(child);
    await settle();
    scheduler.fire(TERMINAL_EXIT_DEADLINE_MS);
    expectErrorCategory(await run, "adapter_protocol_error");
  });

  it.each([
    [0, null],
    [7, null],
    [null, "SIGABRT"]
  ] as const)("classifies early exit code=%s signal=%s without throwing", async (code, signal) => {
    const child = new FakeChild();
    const { run } = harness(child);
    child.finish(code, signal);
    expectErrorCategory(await run, "adapter_protocol_error");
  });
});

describe("malformed, ordering, and capture policy", () => {
  it("continues through exactly ten malformed frames and terminates on the eleventh", async () => {
    const tolerated = new FakeChild();
    const toleratedHarness = harness(tolerated);
    await emitHandshake(tolerated);
    tolerated.emitStdout(event("session_started", 2, { session_id: "session-1" }));
    tolerated.emitStdout("not-json\n".repeat(10));
    tolerated.emitStdout(event("run_completed", 3, { summary: "done" }));
    tolerated.finish(0);
    await expect(toleratedHarness.run).resolves.toMatchObject({
      status: "completed",
      incomplete: true,
      malformedFrameCount: 10,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ classification: "invalid_json" })
      ])
    });

    const rejected = new FakeChild();
    const rejectedHarness = harness(rejected);
    await emitHandshake(rejected);
    rejected.emitStdout(event("session_started", 2, { session_id: "session-1" }));
    rejected.emitStdout("not-json\n".repeat(11));
    expectErrorCategory(await rejectedHarness.run, "adapter_protocol_error");
  });

  it("counts sequence and pairing defects, resynchronizes, and marks the trajectory incomplete", async () => {
    const child = new FakeChild();
    const { run } = harness(child);
    await emitHandshake(child);
    child.emitStdout(event("session_started", 3, { session_id: "wrong-sequence" }));
    child.emitStdout(event("session_started", 4, { session_id: "session-1" }));
    child.emitStdout(event("tool_result", 5, { call_id: "missing", status: "ok", result: "", duration_ms: 0 }));
    child.emitStdout(event("run_completed", 6, { summary: "done" }));
    child.finish(0);
    await expect(run).resolves.toMatchObject({
      status: "completed",
      incomplete: true,
      malformedFrameCount: 2,
      diagnostics: [
        expect.objectContaining({ classification: "sequence" }),
        expect.objectContaining({ classification: "cross_frame" })
      ]
    });
  });

  it("rejects output after a terminal frame as adapter_protocol_error", async () => {
    const child = new FakeChild();
    const { run } = harness(child);
    await emitHandshake(child);
    emitHappy(child);
    child.emitStdout(event("log", 4, { level: "info", message: "too late" }));
    child.finish(0);
    expectErrorCategory(await run, "adapter_protocol_error");
  });

  it("uses fatal UTF-8 handling for stdout and never leaks a malformed raw fallback", async () => {
    const child = new FakeChild();
    const redactor: AdapterCaptureRedactor = {
      redactJson: (value) => value,
      redactBytes: () => { throw new Error("redactor unavailable"); }
    };
    const spawn: SpawnAdapterProcess = () => child;
    const run = superviseAdapter({
      command: ["adapter"], spec: RUN_SPEC, cwd: "/workspace", env: {}, redactor, spawn,
      scheduler: new ManualScheduler()
    });
    await emitHandshake(child);
    child.emitStdout(new Uint8Array([0x73, 0x6b, 0x2d, 0xc3, 0x28, 0x0a]));
    const result = await run;
    expectErrorCategory(result, "redaction_failed");
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("redacts validated events and bounded head-and-tail stderr before returning either", async () => {
    const child = new FakeChild();
    const { run } = harness(child);
    await emitHandshake(child);
    child.emitStdout(event("session_started", 2, { session_id: "session-1" }));
    child.emitStdout(event("text_output", 3, { text: "sk-secret-value" }));
    child.emitStdout(event("run_completed", 4, { summary: "done" }));
    child.emitStderr(`HEAD-sk-secret-value-${"x".repeat(300_000)}-TAIL-sk-secret-value`);
    child.finish(0);
    const result = await run;
    expect(result.stderr.droppedBytes).toBeGreaterThan(0);
    expect(result.stderr.redacted).toContain("HEAD-[REDACTED]");
    expect(result.stderr.redacted).toContain("TAIL-[REDACTED]");
    expect(result.stderr.redacted).toMatch(/\.\.\.\[[0-9]+ bytes elided\]\.\.\./u);
    expect(encoder.encode(result.stderr.redacted).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "text_output",
      text: "[REDACTED]"
    }));
  });
});
