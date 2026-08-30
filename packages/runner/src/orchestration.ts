import { AssayError, type AssayErrorCategory } from "@assay/contracts";

import {
  createTaskRunLifecycle,
  transitionTaskRun,
  type TaskRunLifecycle,
  type TaskRunTransition
} from "./state-machine.js";

export type AssertionStageResult =
  | { readonly hasJudgeAssertions: false; readonly outcome: "pass" | "fail" }
  | { readonly hasJudgeAssertions: true; readonly outcome?: never };

export interface TaskRunStages<TPlan, TWorkspace, TAgent, TCollection, TEvidence> {
  readonly materialize: (plan: TPlan, signal: AbortSignal) => Promise<TWorkspace>;
  readonly startAgent: (
    plan: TPlan,
    workspace: TWorkspace,
    signal: AbortSignal
  ) => Promise<TAgent>;
  readonly collect: (
    plan: TPlan,
    workspace: TWorkspace,
    agent: TAgent,
    signal: AbortSignal
  ) => Promise<TCollection>;
  readonly seal: (
    plan: TPlan,
    workspace: TWorkspace,
    collection: TCollection,
    signal: AbortSignal
  ) => Promise<TEvidence>;
  readonly assert: (
    plan: TPlan,
    evidence: TEvidence,
    signal: AbortSignal
  ) => Promise<AssertionStageResult>;
  readonly judge?: (
    plan: TPlan,
    evidence: TEvidence,
    signal: AbortSignal
  ) => Promise<"pass" | "fail">;
  readonly persist: (
    plan: TPlan,
    lifecycle: TaskRunLifecycle,
    evidence: TEvidence | undefined
  ) => Promise<void>;
  readonly cleanup: (
    plan: TPlan,
    workspace: TWorkspace | undefined,
    agent: TAgent | undefined
  ) => Promise<void>;
}

export interface TaskRunExecutionResult {
  readonly lifecycle: TaskRunLifecycle;
  readonly history: readonly TaskRunLifecycle[];
}

function categoryOf(error: unknown): AssayErrorCategory {
  return error instanceof AssayError ? error.category : "internal_invariant";
}

export async function executeTaskRun<TPlan, TWorkspace, TAgent, TCollection, TEvidence>(
  plan: TPlan,
  stages: TaskRunStages<TPlan, TWorkspace, TAgent, TCollection, TEvidence>,
  signal: AbortSignal
): Promise<TaskRunExecutionResult> {
  let lifecycle = createTaskRunLifecycle();
  const history: TaskRunLifecycle[] = [lifecycle];
  let workspace: TWorkspace | undefined;
  let agent: TAgent | undefined;
  let evidence: TEvidence | undefined;
  let persistenceAttempted = false;
  let cleanupAttempted = false;

  function advance(transition: TaskRunTransition): void {
    lifecycle = transitionTaskRun(lifecycle, transition);
    history.push(lifecycle);
  }

  async function persistSettlement(): Promise<void> {
    if (lifecycle.errorCategory === "redaction_failed" || persistenceAttempted) {
      return;
    }
    persistenceAttempted = true;
    await stages.persist(plan, lifecycle, evidence);
  }

  async function cleanup(): Promise<void> {
    if (cleanupAttempted || (workspace === undefined && agent === undefined)) {
      return;
    }
    cleanupAttempted = true;
    await stages.cleanup(plan, workspace, agent);
  }

  try {
    signal.throwIfAborted();
    advance({ type: "dispatch" });
    workspace = await stages.materialize(plan, signal);
    signal.throwIfAborted();
    agent = await stages.startAgent(plan, workspace, signal);
    signal.throwIfAborted();
    advance({ type: "adapter_ready" });

    const collection = await stages.collect(plan, workspace, agent, signal);
    signal.throwIfAborted();
    advance({ type: "collection_finished" });
    evidence = await stages.seal(plan, workspace, collection, signal);
    signal.throwIfAborted();
    advance({ type: "evidence_sealed" });

    const assertionResult = await stages.assert(plan, evidence, signal);
    signal.throwIfAborted();
    if (assertionResult.hasJudgeAssertions) {
      advance({ type: "assertions_finished", hasJudgeAssertions: true });
      if (stages.judge === undefined) {
        throw new AssayError(
          "internal_invariant",
          "internal_invariant: judge assertions reached orchestration without a judge stage"
        );
      }
      const outcome = await stages.judge(plan, evidence, signal);
      signal.throwIfAborted();
      advance({ type: "judge_votes_finished", outcome });
    } else {
      advance({
        type: "assertions_finished",
        hasJudgeAssertions: false,
        outcome: assertionResult.outcome
      });
    }

    persistenceAttempted = true;
    await stages.persist(plan, lifecycle, evidence);
    advance({ type: "durable_write_acknowledged" });
    await cleanup();
    advance({ type: "completion_acknowledged" });
  } catch (error) {
    if (lifecycle.state !== "completed" && lifecycle.state !== "failed_infrastructure" &&
        lifecycle.state !== "timed_out" && lifecycle.state !== "cancelled" &&
        lifecycle.state !== "quarantined") {
      const category = signal.aborted ? "cancelled" : categoryOf(error);
      if (category === "cancelled") {
        advance({ type: "cancel_requested" });
      } else if (category === "sandbox_timeout") {
        advance({ type: "deadline_elapsed" });
      } else if (category === "storage_corrupt" && lifecycle.state === "persisted") {
        advance({ type: "integrity_failed" });
      } else {
        advance({ type: "infrastructure_failed", category });
      }
    }

    try {
      await persistSettlement();
    } catch {
      // A failed store attempt is already represented by the terminal lifecycle.
      // Recovery owns any non-durable record; retrying here could duplicate effects.
    }
    try {
      await cleanup();
    } catch {
      // Preserve the original terminal category while still making one cleanup attempt.
    }
  }

  return { lifecycle, history };
}

export async function runTaskRunsSequentially<TPlan, TResult>(
  plans: readonly TPlan[],
  execute: (plan: TPlan, signal: AbortSignal) => Promise<TResult>,
  signal: AbortSignal
): Promise<readonly TResult[]> {
  const results: TResult[] = [];
  for (const plan of plans) {
    results.push(await execute(plan, signal));
  }
  return results;
}
