import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  parseAdapterRunSpecFrame,
  superviseAdapter,
  type AdapterCaptureRedactor,
  type AdapterRunSpec,
  type AdapterScheduler,
  type ScheduledCallback
} from "@assay/adapter-core";
import { afterEach, describe, expect, it } from "vitest";

import { simulatedAdapterCommand } from "../../src/command.js";

const fixtureRoot = new URL("../../../../fixtures/trajectories/", import.meta.url);
const tempPaths: string[] = [];

const REDACTOR: AdapterCaptureRedactor = {
  redactJson: (value) => value,
  redactBytes: (bytes) => new TextDecoder("utf-8").decode(bytes)
};

class AcceleratedGraceScheduler implements AdapterScheduler {
  schedule(delayMs: number, callback: () => void): ScheduledCallback {
    const effective = delayMs === 5_000 ? 100 : delayMs;
    const timer = setTimeout(callback, effective);
    return { cancel: () => clearTimeout(timer) };
  }
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runFixture(
  name: string,
  wallClockMs = 3_000,
  scheduler?: AdapterScheduler
): Promise<Awaited<ReturnType<typeof superviseAdapter>>> {
  const workspace = await mkdtemp(join(tmpdir(), "assay-sim-process-"));
  tempPaths.push(workspace);
  const spec: AdapterRunSpec = parseAdapterRunSpecFrame(JSON.stringify({
    type: "run_spec",
    contract: "assay-adapter/1",
    task_id: "simulated-task",
    task_run_id: "018f0f5e-7b3c-7def-8abc-0123456789ab",
    prompt: "Run the script.",
    workspace_path: workspace,
    seed: "seed-1",
    env: {},
    limits: { wall_clock_ms: wallClockMs },
    budgets_advisory: {}
  }));
  return superviseAdapter({
    command: simulatedAdapterCommand({
      scenarioPath: fileURLToPath(new URL(name, fixtureRoot))
    }),
    spec,
    cwd: workspace,
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    redactor: REDACTOR,
    ...(scheduler === undefined ? {} : { scheduler })
  });
}

describe("simulated adapter subprocess", () => {
  it("completes a real handshake-first multi-turn run with no provider, network, or cost", async () => {
    const result = await runFixture("happy-multi-turn.json");
    expect(result).toMatchObject({
      status: "completed",
      errorCategory: null,
      incomplete: false,
      descriptor: {
        id: "adapter-simulated",
        tier: "full",
        model: { provider: "synthetic", model: "scripted-v1", family: "synthetic" }
      }
    });
    expect(result.events.filter((entry) => entry.type === "usage")).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ source: "synthetic", costUsdMicros: 0 }) }),
      expect.objectContaining({ usage: expect.objectContaining({ source: "synthetic", costUsdMicros: 0 }) })
    ]);
  });

  it("applies filesystem directives in the subprocess workspace", async () => {
    const result = await runFixture("filesystem.json");
    expect(result.status).toBe("completed");
    const workspace = tempPaths.at(-1) as string;
    await expect(readFile(join(workspace, "nested/kept.txt"), "utf8"))
      .resolves.toBe("deterministic\n");
  });

  it.each([
    ["run-failed-agent-gave-up.json", "agent_gave_up"],
    ["run-failed-agent-crashed.json", "agent_crashed"],
    ["run-failed-provider-error.json", "provider_error"],
    ["run-failed-internal.json", "internal"]
  ] as const)("preserves %s as a clean run_failed terminal", async (name, category) => {
    const result = await runFixture(name);
    expect(result).toMatchObject({
      status: "failed",
      errorCategory: null,
      incomplete: false,
      exit: { code: 0, signal: null }
    });
    expect(result.events.at(-1)).toMatchObject({ type: "run_failed", category });
  });

  it.each([
    ["malformed-json.json", "completed", null, "invalid_json"],
    ["garbage-stdout.json", "completed", null, "invalid_json"],
    ["invalid-utf8.json", "completed", null, "invalid_utf8"],
    ["oversized-frame.json", "completed", null, "oversized_frame"],
    ["sequence-gap.json", "completed", null, "sequence"],
    ["missing-tool-result.json", "completed", null, null],
    ["usage-arithmetic-error.json", "completed", null, "schema_validation"],
    ["post-terminal-frame.json", "error", "adapter_protocol_error", "post_terminal"],
    ["exit-zero-without-terminal.json", "error", "adapter_protocol_error", null],
    ["crash-at-step.json", "error", "adapter_protocol_error", null],
    ["early-exit.json", "error", "adapter_protocol_error", null],
    ["frame-flood.json", "error", "adapter_protocol_error", null]
  ] as const)("drives %s through the real supervisor", async (name, status, category, diagnostic) => {
    const result = await runFixture(name, 8_000);
    expect(result.status).toBe(status);
    expect(result.errorCategory).toBe(category);
    if (status === "completed") {
      expect(result.incomplete).toBe(true);
    }
    if (diagnostic !== null) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ classification: diagnostic }));
    }
  });

  it("hangs until the supervisor sends SIGTERM", async () => {
    const result = await runFixture("hang-until-timeout.json", 250, new AcceleratedGraceScheduler());
    expect(result).toMatchObject({
      status: "error",
      errorCategory: "sandbox_timeout",
      termination: { sigtermSent: true }
    });
  });

  it("can deliberately ignore SIGTERM so the supervisor proves SIGKILL escalation", async () => {
    const result = await runFixture("ignore-sigterm.json", 250, new AcceleratedGraceScheduler());
    expect(result).toMatchObject({
      status: "error",
      errorCategory: "sandbox_timeout",
      termination: { sigtermSent: true, sigkillSent: true }
    });
  });
});
