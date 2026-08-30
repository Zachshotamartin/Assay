import {
  AssayError,
  TERMINAL_TASK_RUN_STATES,
  type AssayErrorCategory,
  type TaskOutcome,
  type TaskRunState
} from "@assay/contracts";

export interface TaskRunLifecycle {
  readonly state: TaskRunState;
  readonly outcome: TaskOutcome | null;
  readonly errorCategory: AssayErrorCategory | null;
}

type ScoredOutcome = Exclude<TaskOutcome, "error">;

export type TaskRunTransition =
  | { readonly type: "dispatch" }
  | { readonly type: "adapter_ready" }
  | { readonly type: "collection_finished" }
  | { readonly type: "evidence_sealed" }
  | {
      readonly type: "assertions_finished";
      readonly hasJudgeAssertions: true;
      readonly outcome?: never;
    }
  | {
      readonly type: "assertions_finished";
      readonly hasJudgeAssertions: false;
      readonly outcome: ScoredOutcome;
    }
  | { readonly type: "judge_votes_finished"; readonly outcome: ScoredOutcome }
  | { readonly type: "durable_write_acknowledged" }
  | { readonly type: "completion_acknowledged" }
  | {
      readonly type: "infrastructure_failed";
      readonly category: AssayErrorCategory;
    }
  | { readonly type: "deadline_elapsed" }
  | { readonly type: "cancel_requested" }
  | { readonly type: "integrity_failed" };

const terminalStates = new Set<TaskRunState>(TERMINAL_TASK_RUN_STATES);

const ordinaryTargets = new Map<TaskRunState, ReadonlySet<TaskRunState>>([
  ["planned", new Set(["materializing"])],
  ["materializing", new Set(["agent_running"])],
  ["agent_running", new Set(["collecting"])],
  ["collecting", new Set(["asserting"])],
  ["asserting", new Set(["judging", "scored"])],
  ["judging", new Set(["scored"])],
  ["scored", new Set(["persisted"])],
  ["persisted", new Set(["completed", "quarantined"])]
]);

export function canTransitionTaskRun(from: TaskRunState, to: TaskRunState): boolean {
  if (terminalStates.has(from)) {
    return false;
  }
  if (ordinaryTargets.get(from)?.has(to) === true) {
    return true;
  }
  return to === "failed_infrastructure" || to === "timed_out" || to === "cancelled";
}

export function createTaskRunLifecycle(
  state: TaskRunState = "planned",
  outcome: TaskOutcome | null = null,
  errorCategory: AssayErrorCategory | null = null
): TaskRunLifecycle {
  return { state, outcome, errorCategory };
}

function invalidTransition(
  current: TaskRunLifecycle,
  target: TaskRunState,
  trigger: TaskRunTransition["type"]
): never {
  throw new AssayError(
    "internal_invariant",
    `internal_invariant: illegal task-run transition ${current.state} -> ${target} for ${trigger}`
  );
}

function move(
  current: TaskRunLifecycle,
  target: TaskRunState,
  trigger: TaskRunTransition["type"],
  outcome: TaskOutcome | null = current.outcome,
  errorCategory: AssayErrorCategory | null = current.errorCategory
): TaskRunLifecycle {
  if (!canTransitionTaskRun(current.state, target)) {
    return invalidTransition(current, target, trigger);
  }
  return { state: target, outcome, errorCategory };
}

export function transitionTaskRun(
  current: TaskRunLifecycle,
  transition: TaskRunTransition
): TaskRunLifecycle {
  switch (transition.type) {
    case "dispatch":
      return move(current, "materializing", transition.type);
    case "adapter_ready":
      return move(current, "agent_running", transition.type);
    case "collection_finished":
      return move(current, "collecting", transition.type);
    case "evidence_sealed":
      return move(current, "asserting", transition.type);
    case "assertions_finished":
      return transition.hasJudgeAssertions
        ? move(current, "judging", transition.type)
        : move(current, "scored", transition.type, transition.outcome, null);
    case "judge_votes_finished":
      return move(current, "scored", transition.type, transition.outcome, null);
    case "durable_write_acknowledged":
      return move(current, "persisted", transition.type);
    case "completion_acknowledged":
      return move(current, "completed", transition.type);
    case "infrastructure_failed":
      return move(
        current,
        "failed_infrastructure",
        transition.type,
        "error",
        transition.category
      );
    case "deadline_elapsed":
      return move(current, "timed_out", transition.type, "error", "sandbox_timeout");
    case "cancel_requested":
      return move(current, "cancelled", transition.type, "error", "cancelled");
    case "integrity_failed":
      return move(current, "quarantined", transition.type, "error", "storage_corrupt");
  }
}
