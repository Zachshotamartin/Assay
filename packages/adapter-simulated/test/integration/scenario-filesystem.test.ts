import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAdapterRunSpecFrame, type AdapterRunSpec } from "@assay/adapter-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeSimulatedScenario,
  parseSimulatedScenarioJson,
  type SimulatedAction,
  type SimulatedClock
} from "../../src/scenario.js";

const fixtureRoot = new URL("../../../../fixtures/trajectories/", import.meta.url);
const temporaryPaths: string[] = [];
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

class FixedClock implements SimulatedClock {
  timestamp(): string {
    return "2026-01-02T03:04:05.006Z";
  }

  async sleep(_milliseconds: number): Promise<void> {}
}

async function collect(iterable: AsyncIterable<SimulatedAction>): Promise<readonly SimulatedAction[]> {
  const actions: SimulatedAction[] = [];
  for await (const action of iterable) actions.push(action);
  return actions;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("simulated scenario filesystem boundary", () => {
  it("applies write/delete only inside the run workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "assay-sim-workspace-"));
    temporaryPaths.push(workspace);
    const scenario = parseSimulatedScenarioJson(
      await readFile(new URL("filesystem.json", fixtureRoot), "utf8")
    );
    await collect(executeSimulatedScenario(scenario, { ...SPEC, workspacePath: workspace }, {
      clock: new FixedClock()
    }));
    await expect(readFile(join(workspace, "nested/kept.txt"), "utf8"))
      .resolves.toBe("deterministic\n");
    await expect(readFile(join(workspace, "deleted.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const outside = await mkdtemp(join(tmpdir(), "assay-sim-outside-"));
    temporaryPaths.push(outside);
    await symlink(outside, join(workspace, "escape"));
    for (const path of ["../outside.txt", "/tmp/outside.txt", "escape/outside.txt"]) {
      const invalid = parseSimulatedScenarioJson(JSON.stringify({
        scenario_version: 1,
        steps: [{ write_file: { path, contents: "forbidden" } }]
      }));
      await expect(collect(executeSimulatedScenario(invalid, { ...SPEC, workspacePath: workspace }, {
        clock: new FixedClock()
      }))).rejects.toThrow(/workspace/u);
    }
  });
});
