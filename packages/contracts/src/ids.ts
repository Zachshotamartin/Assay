import { AssayError } from "./errors.js";

declare const taskIdBrand: unique symbol;
declare const runIdBrand: unique symbol;
declare const taskRunIdBrand: unique symbol;
declare const sandboxIdBrand: unique symbol;
declare const blobHashBrand: unique symbol;
declare const contentHashBrand: unique symbol;
declare const variantNameBrand: unique symbol;
declare const trajectoryMetricIdBrand: unique symbol;

export type TaskId = string & { readonly [taskIdBrand]: "TaskId" };
export type RunId = string & { readonly [runIdBrand]: "RunId" };
export type TaskRunId = string & { readonly [taskRunIdBrand]: "TaskRunId" };
export type SandboxId = string & { readonly [sandboxIdBrand]: "SandboxId" };
export type BlobHash = string & { readonly [blobHashBrand]: "BlobHash" };
export type ContentHash = string & { readonly [contentHashBrand]: "ContentHash" };
export type VariantName = string & { readonly [variantNameBrand]: "VariantName" };
export type TrajectoryMetricId = string & {
  readonly [trajectoryMetricIdBrand]: "TrajectoryMetricId";
};

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TRAJECTORY_METRIC_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

function invalid(kind: string, value: string): never {
  const rendered = value.length > 80 ? `${value.slice(0, 77)}...` : value;
  throw new AssayError(
    "invalid_invocation",
    `invalid_invocation: invalid ${kind} ${JSON.stringify(rendered)}`
  );
}

function validated<T extends string>(kind: string, value: string, pattern: RegExp): T {
  if (!pattern.test(value)) {
    return invalid(kind, value);
  }
  return value as T;
}

export function createTaskId(value: string): TaskId {
  return validated("TaskId", value, TASK_ID_PATTERN);
}

export function createRunId(value: string): RunId {
  return validated("RunId", value, UUID_V7_PATTERN);
}

export function createTaskRunId(value: string): TaskRunId {
  return validated("TaskRunId", value, UUID_V7_PATTERN);
}

export function createSandboxId(value: string): SandboxId {
  return validated("SandboxId", value, UUID_V7_PATTERN);
}

export function createBlobHash(value: string): BlobHash {
  return validated("BlobHash", value, SHA256_PATTERN);
}

export function createContentHash(value: string): ContentHash {
  return validated("ContentHash", value, SHA256_PATTERN);
}

export function createVariantName(value: string): VariantName {
  return validated("VariantName", value, TASK_ID_PATTERN);
}

export function createTrajectoryMetricId(value: string): TrajectoryMetricId {
  return validated("TrajectoryMetricId", value, TRAJECTORY_METRIC_ID_PATTERN);
}
