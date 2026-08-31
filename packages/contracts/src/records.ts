import type { AssayErrorCategory } from "./errors.js";
import type {
  BlobHash,
  ContentHash,
  RunId,
  TaskId,
  TaskRunId,
  VariantName
} from "./ids.js";

export const TASK_RUN_STATES = [
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
] as const;

export type TaskRunState = (typeof TASK_RUN_STATES)[number];

export const TERMINAL_TASK_RUN_STATES = [
  "completed",
  "failed_infrastructure",
  "timed_out",
  "cancelled",
  "quarantined"
] as const satisfies readonly TaskRunState[];

export type TerminalTaskRunState = (typeof TERMINAL_TASK_RUN_STATES)[number];
export type TaskOutcome = "pass" | "fail" | "error";
export type RunStatus = "in_progress" | "completed" | "failed" | "cancelled";
export type RunSeedStrategy = "derived" | "fixed";
export type RunAdapterTier = "full" | "trajectory" | "black_box";

export interface RunTaskIdentity {
  readonly taskId: TaskId;
  readonly taskContentHash: ContentHash;
  readonly repetitions: number;
  readonly rootSeed: number;
  readonly seedStrategy: RunSeedStrategy;
  readonly effectiveSeeds: readonly string[];
}

export interface RunVariantIdentity {
  readonly name: VariantName;
  readonly adapter: string;
  readonly model: string;
  readonly promptVersion: string | null;
  readonly toolsetVersion: string | null;
  readonly agentVersion: string | null;
}

export interface ProviderReportedModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly family: string;
}

export interface AssertionResult {
  readonly type: string;
  readonly target: string;
  readonly observed: unknown;
  readonly expectation: unknown;
  readonly verdict: "pass" | "fail" | "error";
  readonly durationMs: number;
  readonly errorCategory?: AssayErrorCategory;
  readonly message?: string;
}

export interface UsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly providerReportedCostUsd: number | null;
  readonly catalogEstimatedCostUsd: number | null;
  readonly reconciliation: "reconciled" | "unreconciled" | "synthetic";
  readonly providerLatencyMs: number;
  readonly toolLatencyMs: number;
  readonly harnessOverheadMs: number;
}

export interface RunRecord {
  readonly runId: RunId;
  readonly createdAtUtc: string;
  readonly suitePath: string;
  readonly suiteContentHash: ContentHash;
  readonly tasks: readonly RunTaskIdentity[];
  readonly variant: RunVariantIdentity;
  readonly configHash: ContentHash;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly contractVersion: "assay-adapter/1";
  readonly adapterTier: RunAdapterTier;
  readonly providerReportedModel: ProviderReportedModelIdentity | null;
  readonly rootSeed: number;
  readonly harnessVersion: string;
  readonly pricingCatalogVersion: string;
  readonly runsPerTask: number;
  readonly status: RunStatus;
  readonly isolationLabel: "isolated" | "network_allowlisted" | "unsafe_host";
}

export interface TaskRunRecord {
  readonly taskRunId: TaskRunId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly taskContentHash: ContentHash;
  readonly repetition: number;
  readonly attempt: number;
  readonly seed: string;
  readonly state: TaskRunState;
  readonly outcome: TaskOutcome | null;
  readonly errorCategory: string | null;
  readonly trajectoryBlob: BlobHash | null;
  readonly workspaceSnapshot: BlobHash | null;
  readonly assertionResults: readonly AssertionResult[];
  readonly usage: UsageRecord | null;
  readonly startedAtUtc: string;
  readonly endedAtUtc: string | null;
}

export type NewRunRecord = Omit<RunRecord, "runId">;
export type NewTaskRunRecord = Omit<TaskRunRecord, "taskRunId" | "runId">;
