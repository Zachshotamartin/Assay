import { describe, expect, it } from "vitest";

import { AssayError } from "@assay/contracts";

import {
  executeTaskRun,
  runTaskRunsSequentially,
  type TaskRunStages
} from "./orchestration.js";

interface Plan { readonly id: string }
interface Workspace { readonly id: string }
interface Agent { readonly id: string }
interface Collection { readonly terminal: true }
interface Evidence { readonly snapshot: string }

function stages(
  calls: string[],
  overrides: Partial<TaskRunStages<Plan, Workspace, Agent, Collection, Evidence>> = {}
): TaskRunStages<Plan, Workspace, Agent, Collection, Evidence> {
  return {
    async materialize(plan) {
      calls.push(`materialize:${plan.id}`);
      return { id: `workspace:${plan.id}` };
    },
    async startAgent(plan) {
      calls.push(`start:${plan.id}`);
      return { id: `agent:${plan.id}` };
    },
    async collect(plan) {
      calls.push(`collect:${plan.id}`);
      return { terminal: true };
    },
    async seal(plan) {
      calls.push(`seal:${plan.id}`);
      return { snapshot: `snapshot:${plan.id}` };
    },
    async assert(plan) {
      calls.push(`assert:${plan.id}`);
      return { hasJudgeAssertions: false, outcome: "pass" };
    },
    async persist(plan, lifecycle) {
      calls.push(`persist:${plan.id}:${lifecycle.state}:${lifecycle.outcome}`);
    },
    async cleanup(plan) {
      calls.push(`cleanup:${plan.id}`);
    },
    ...overrides
  };
}

describe("R1 sequential task-run orchestration", () => {
  it("drives every happy-path stage in fixed order and persists the scored result", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "one" }, stages(calls), new AbortController().signal
    );

    expect(calls).toEqual([
      "materialize:one", "start:one", "collect:one", "seal:one", "assert:one",
      "cleanup:one", "persist:one:scored:pass"
    ]);
    expect(result.history.map(({ state }) => state)).toEqual([
      "planned", "materializing", "agent_running", "collecting", "asserting",
      "scored", "persisted", "completed"
    ]);
    expect(result.lifecycle).toMatchObject({ state: "completed", outcome: "pass" });
  });

  it("runs the judge stage only for a declared judge layer", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "judge" },
      stages(calls, {
        async assert(plan) {
          calls.push(`assert:${plan.id}`);
          return { hasJudgeAssertions: true };
        },
        async judge(plan) {
          calls.push(`judge:${plan.id}`);
          return "fail";
        }
      }),
      new AbortController().signal
    );

    expect(calls).toContain("judge:judge");
    expect(result.history.map(({ state }) => state)).toContain("judging");
    expect(result.lifecycle).toMatchObject({ state: "completed", outcome: "fail" });
  });

  it("classifies an adapter error as infrastructure error, never task failure", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "broken" },
      stages(calls, {
        async collect() {
          throw new AssayError("adapter_protocol_error", "bad frame");
        }
      }),
      new AbortController().signal
    );

    expect(result.lifecycle).toEqual({
      state: "failed_infrastructure",
      outcome: "error",
      errorCategory: "adapter_protocol_error"
    });
    expect(calls).toContain("persist:broken:failed_infrastructure:error");
    expect(calls.at(-1)).toBe("cleanup:broken");
  });

  it("fails closed without persistence when redaction fails", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "secret" },
      stages(calls, {
        async seal() {
          throw new AssayError("redaction_failed", "scanner unavailable");
        }
      }),
      new AbortController().signal
    );

    expect(result.lifecycle).toMatchObject({
      state: "failed_infrastructure", outcome: "error", errorCategory: "redaction_failed"
    });
    expect(calls.some((call) => call.startsWith("persist:"))).toBe(false);
    expect(calls.at(-1)).toBe("cleanup:secret");
  });

  it("records cancellation before admitting work and still persists settlement", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await executeTaskRun({ id: "cancel" }, stages(calls), controller.signal);

    expect(calls).toEqual(["persist:cancel:cancelled:error"]);
    expect(result.lifecycle).toEqual({
      state: "cancelled", outcome: "error", errorCategory: "cancelled"
    });
  });

  it("maps a monotonic deadline failure to timed_out", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "slow" },
      stages(calls, {
        async collect() {
          throw new AssayError("sandbox_timeout", "deadline elapsed");
        }
      }),
      new AbortController().signal
    );

    expect(result.lifecycle).toEqual({
      state: "timed_out", outcome: "error", errorCategory: "sandbox_timeout"
    });
  });

  it("settles cleanup before persistence and durably records cleanup failure", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "cleanup-failure" },
      stages(calls, {
        async cleanup(plan) {
          calls.push(`cleanup:${plan.id}`);
          throw new AssayError("sandbox_start_failed", "cleanup failed");
        }
      }),
      new AbortController().signal
    );

    expect(result.lifecycle).toEqual({
      state: "failed_infrastructure",
      outcome: "error",
      errorCategory: "sandbox_start_failed"
    });
    expect(calls.at(-1)).toBe(
      "persist:cleanup-failure:failed_infrastructure:error"
    );
  });

  it("converts an unknown thrown value once into internal_invariant", async () => {
    const calls: string[] = [];
    const result = await executeTaskRun(
      { id: "unknown" },
      stages(calls, {
        async materialize() {
          throw "not an Error";
        }
      }),
      new AbortController().signal
    );

    expect(result.lifecycle).toMatchObject({
      state: "failed_infrastructure", outcome: "error", errorCategory: "internal_invariant"
    });
  });

  it("never overlaps task executions and preserves plan order", async () => {
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const results = await runTaskRunsSequentially(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (plan) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        starts.push(plan.id);
        await Promise.resolve();
        active -= 1;
        return plan.id.toUpperCase();
      },
      new AbortController().signal
    );

    expect(maximumActive).toBe(1);
    expect(starts).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["A", "B", "C"]);
  });
});
