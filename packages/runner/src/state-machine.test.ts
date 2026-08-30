import { describe, expect, it } from "vitest";

import {
  TASK_RUN_STATES,
  TERMINAL_TASK_RUN_STATES,
  type TaskRunState
} from "@assay/contracts";

import {
  canTransitionTaskRun,
  createTaskRunLifecycle,
  transitionTaskRun
} from "./state-machine.js";

const ordinaryEdges = [
  ["planned", "materializing"],
  ["materializing", "agent_running"],
  ["agent_running", "collecting"],
  ["collecting", "asserting"],
  ["asserting", "judging"],
  ["asserting", "scored"],
  ["judging", "scored"],
  ["scored", "persisted"],
  ["persisted", "completed"],
  ["persisted", "quarantined"]
] as const satisfies readonly (readonly [TaskRunState, TaskRunState])[];

const terminalSet = new Set<TaskRunState>(TERMINAL_TASK_RUN_STATES);

function expectedLegal(from: TaskRunState, to: TaskRunState): boolean {
  if (ordinaryEdges.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to)) {
    return true;
  }
  return !terminalSet.has(from) &&
    (to === "failed_infrastructure" || to === "timed_out" || to === "cancelled");
}

describe("R1 task-run state machine", () => {
  it("pins the complete lifecycle and terminal state vocabularies", () => {
    expect(TASK_RUN_STATES).toEqual([
      "planned",
      "materializing",
      "agent_running",
      "collecting",
      "asserting",
      "judging",
      "scored",
      "persisted",
      "completed",
      "failed_infrastructure",
      "timed_out",
      "cancelled",
      "quarantined"
    ]);
    expect(TERMINAL_TASK_RUN_STATES).toEqual([
      "completed",
      "failed_infrastructure",
      "timed_out",
      "cancelled",
      "quarantined"
    ]);
  });

  it("exhaustively permits only section 3.5 transition edges", () => {
    for (const from of TASK_RUN_STATES) {
      for (const to of TASK_RUN_STATES) {
        expect(canTransitionTaskRun(from, to), `${from} -> ${to}`).toBe(
          expectedLegal(from, to)
        );
      }
    }
  });

  it("drives the no-judge happy path and records a pass independently of state", () => {
    let lifecycle = createTaskRunLifecycle();
    lifecycle = transitionTaskRun(lifecycle, { type: "dispatch" });
    lifecycle = transitionTaskRun(lifecycle, { type: "adapter_ready" });
    lifecycle = transitionTaskRun(lifecycle, { type: "collection_finished" });
    lifecycle = transitionTaskRun(lifecycle, { type: "evidence_sealed" });
    lifecycle = transitionTaskRun(lifecycle, {
      type: "assertions_finished",
      hasJudgeAssertions: false,
      outcome: "pass"
    });

    expect(lifecycle).toEqual({ state: "scored", outcome: "pass", errorCategory: null });
    lifecycle = transitionTaskRun(lifecycle, { type: "durable_write_acknowledged" });
    lifecycle = transitionTaskRun(lifecycle, { type: "completion_acknowledged" });
    expect(lifecycle).toEqual({ state: "completed", outcome: "pass", errorCategory: null });
  });

  it("uses the judging edge only when judge assertions exist", () => {
    let lifecycle = createTaskRunLifecycle("asserting");
    lifecycle = transitionTaskRun(lifecycle, {
      type: "assertions_finished",
      hasJudgeAssertions: true
    });
    expect(lifecycle).toEqual({ state: "judging", outcome: null, errorCategory: null });

    const failed = transitionTaskRun(lifecycle, {
      type: "judge_votes_finished",
      outcome: "fail"
    });
    expect(failed).toEqual({ state: "scored", outcome: "fail", errorCategory: null });
  });

  it("records infrastructure, timeout, cancellation, and quarantine as errors", () => {
    expect(
      transitionTaskRun(createTaskRunLifecycle("collecting"), {
        type: "infrastructure_failed",
        category: "adapter_protocol_error"
      })
    ).toEqual({
      state: "failed_infrastructure",
      outcome: "error",
      errorCategory: "adapter_protocol_error"
    });
    expect(
      transitionTaskRun(createTaskRunLifecycle("agent_running"), { type: "deadline_elapsed" })
    ).toEqual({ state: "timed_out", outcome: "error", errorCategory: "sandbox_timeout" });
    expect(
      transitionTaskRun(createTaskRunLifecycle("planned"), { type: "cancel_requested" })
    ).toEqual({ state: "cancelled", outcome: "error", errorCategory: "cancelled" });
    expect(
      transitionTaskRun(createTaskRunLifecycle("persisted", "pass"), {
        type: "integrity_failed"
      })
    ).toEqual({ state: "quarantined", outcome: "error", errorCategory: "storage_corrupt" });
  });

  it("rejects every trigger from a terminal state as internal_invariant", () => {
    for (const state of TERMINAL_TASK_RUN_STATES) {
      expect(() =>
        transitionTaskRun(createTaskRunLifecycle(state, "error", "internal_invariant"), {
          type: "dispatch"
        })
      ).toThrow(expect.objectContaining({ category: "internal_invariant" }));
    }
  });

  it("rejects a trigger on the wrong source without mutating the prior value", () => {
    const before = createTaskRunLifecycle("planned");
    expect(() => transitionTaskRun(before, { type: "collection_finished" })).toThrow(
      expect.objectContaining({ category: "internal_invariant" })
    );
    expect(before).toEqual({ state: "planned", outcome: null, errorCategory: null });
  });
});
