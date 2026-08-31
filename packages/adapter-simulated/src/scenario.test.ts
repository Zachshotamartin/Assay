import { readFile } from "node:fs/promises";

import {
  parseAdapterEventFrame,
  parseAdapterRunSpecFrame,
  type AdapterRunSpec
} from "@assay/adapter-core";
import { describe, expect, it } from "vitest";

import {
  resolveSimulatedScenarioPath,
  simulatedAdapterCommand
} from "./command.js";
import {
  executeSimulatedScenario,
  parseSimulatedScenarioJson,
  type SimulatedAction,
  type SimulatedClock
} from "./scenario.js";

const fixtureRoot = new URL("../../../fixtures/trajectories/", import.meta.url);

const SPEC: AdapterRunSpec = parseAdapterRunSpecFrame(JSON.stringify({
  type: "run_spec",
  contract: "assay-adapter/1",
  task_id: "simulated-task",
  task_run_id: "018f0f5e-7b3c-7def-8abc-0123456789ab",
  prompt: "Run the deterministic script.",
  workspace_path: "/workspace",
  seed: "seed-1",
  env: {},
  limits: { wall_clock_ms: 10_000 },
  budgets_advisory: {}
}));

async function scenarioFixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), "utf8");
}

async function collect(iterable: AsyncIterable<SimulatedAction>): Promise<readonly SimulatedAction[]> {
  const actions: SimulatedAction[] = [];
  for await (const action of iterable) actions.push(action);
  return actions;
}

class FixedClock implements SimulatedClock {
  #millis = Date.parse("2026-01-02T03:04:05.006Z");
  readonly sleeps: number[] = [];

  timestamp(): string {
    const value = new Date(this.#millis).toISOString();
    this.#millis += 1;
    return value;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
  }
}

describe("strict simulated scenario schema", () => {
  it("exposes a cwd-independent command for the shipped happy scenario", async () => {
    const scenarioPath = resolveSimulatedScenarioPath();
    expect(parseSimulatedScenarioJson(await readFile(scenarioPath, "utf8"))).toMatchObject({
      scenario_version: 1
    });
    const command = simulatedAdapterCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command.at(-1)).toBe(scenarioPath);
  });

  it("accepts every shipped strict JSON fixture with numeric scenario_version 1", async () => {
    for (const name of [
      "happy-multi-turn.json", "filesystem.json", "malformed-json.json",
      "garbage-stdout.json", "invalid-utf8.json", "oversized-frame.json",
      "sequence-gap.json", "post-terminal-frame.json", "missing-tool-result.json",
      "usage-arithmetic-error.json", "exit-zero-without-terminal.json",
      "crash-at-step.json", "early-exit.json", "frame-flood.json",
      "hang-until-timeout.json", "ignore-sigterm.json", "plain-text.json",
      "tool-error-recovery.json", "identical-call-loop.json",
      "budget-token-ramp.json", "run-failed-agent-gave-up.json",
      "run-failed-agent-crashed.json", "run-failed-provider-error.json",
      "run-failed-internal.json"
    ]) {
      expect(parseSimulatedScenarioJson(await scenarioFixture(name))).toMatchObject({
        scenario_version: 1,
        steps: expect.any(Array)
      });
    }
  });

  it.each(["1", "1.0", 0, 2, null])("rejects scenario_version %j", (scenarioVersion) => {
    expect(() => parseSimulatedScenarioJson(JSON.stringify({
      scenario_version: scenarioVersion,
      steps: []
    }))).toThrow(/scenario_version/u);
  });

  it("rejects YAML, unknown keys, ambiguous steps, and emit payloads outside AdapterEvent", () => {
    expect(() => parseSimulatedScenarioJson("scenario_version: 1\nsteps: []\n")).toThrow(/JSON/u);
    expect(() => parseSimulatedScenarioJson(JSON.stringify({
      scenario_version: 1, steps: [], unknown: true
    }))).toThrow(/unknown/u);
    expect(() => parseSimulatedScenarioJson(JSON.stringify({
      scenario_version: 1, steps: [{ sleep_ms: 1, misbehave: "malformed_json" }]
    }))).toThrow(/step/u);
    expect(() => parseSimulatedScenarioJson(JSON.stringify({
      scenario_version: 1,
      steps: [{ emit: { type: "text_output", seq: 2, text: "not payload-only" } }]
    }))).toThrow(/emit/u);
  });
});

describe("deterministic scenario execution", () => {
  it("produces byte-identical multi-turn frames with synthetic zero-cost usage", async () => {
    const scenario = parseSimulatedScenarioJson(await scenarioFixture("happy-multi-turn.json"));
    const first = await collect(executeSimulatedScenario(scenario, SPEC, { clock: new FixedClock() }));
    const second = await collect(executeSimulatedScenario(scenario, SPEC, { clock: new FixedClock() }));
    const firstBytes = first.filter((action) => action.kind === "stdout").map((action) => action.bytes);
    const secondBytes = second.filter((action) => action.kind === "stdout").map((action) => action.bytes);
    expect(firstBytes).toEqual(secondBytes);

    const events = firstBytes.map((bytes) =>
      parseAdapterEventFrame(new TextDecoder().decode(bytes).slice(0, -1))
    );
    expect(events.map((entry) => entry.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(events.filter((entry) => entry.type === "usage")).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ source: "synthetic", costUsdMicros: 0 }) }),
      expect.objectContaining({ usage: expect.objectContaining({ source: "synthetic", costUsdMicros: 0 }) })
    ]);
  });

  it("ships tool recovery, loop, token-ramp, and every run_failed fixture", async () => {
    const recovery = await collect(executeSimulatedScenario(
      parseSimulatedScenarioJson(await scenarioFixture("tool-error-recovery.json")),
      SPEC,
      { clock: new FixedClock() }
    ));
    const recoveryEvents = recovery
      .filter((action) => action.kind === "stdout")
      .map((action) => parseAdapterEventFrame(new TextDecoder().decode(action.bytes).slice(0, -1)));
    expect(recoveryEvents).toContainEqual(expect.objectContaining({
      type: "tool_result",
      status: "error"
    }));
    expect(recoveryEvents.at(-1)?.type).toBe("run_completed");

    const loop = await collect(executeSimulatedScenario(
      parseSimulatedScenarioJson(await scenarioFixture("identical-call-loop.json")),
      SPEC,
      { clock: new FixedClock() }
    ));
    const loopCalls = loop
      .filter((action) => action.kind === "stdout")
      .map((action) => parseAdapterEventFrame(new TextDecoder().decode(action.bytes).slice(0, -1)))
      .filter((event) => event.type === "tool_call");
    expect(loopCalls).toHaveLength(2);
    expect(loopCalls[0]?.args).toEqual(loopCalls[1]?.args);
    expect(loopCalls[0]?.callId).not.toBe(loopCalls[1]?.callId);

    const ramp = await collect(executeSimulatedScenario(
      parseSimulatedScenarioJson(await scenarioFixture("budget-token-ramp.json")),
      SPEC,
      { clock: new FixedClock() }
    ));
    expect(ramp
      .filter((action) => action.kind === "stdout")
      .map((action) => parseAdapterEventFrame(new TextDecoder().decode(action.bytes).slice(0, -1)))
      .filter((event) => event.type === "usage")
      .map((event) => event.usage.totalTokens)).toEqual([10, 20, 40]);

    for (const category of ["agent_gave_up", "agent_crashed", "provider_error", "internal"] as const) {
      const scenario = parseSimulatedScenarioJson(
        await scenarioFixture(`run-failed-${category.replaceAll("_", "-")}.json`)
      );
      const actions = await collect(executeSimulatedScenario(scenario, SPEC, {
        clock: new FixedClock()
      }));
      const last = actions.at(-1);
      expect(last?.kind).toBe("stdout");
      if (last?.kind === "stdout") {
        expect(parseAdapterEventFrame(new TextDecoder().decode(last.bytes).slice(0, -1)))
          .toMatchObject({ type: "run_failed", category });
      }
    }
  });
});
