import { Ajv } from "ajv";

import eventSchema from "../schemas/assay-event.v1.schema.json" with { type: "json" };
import { canonicalJson } from "./canonical-json.js";
import { AssayError } from "./errors.js";
import { createRunId, createTaskRunId, type RunId, type TaskRunId } from "./ids.js";

export const ASSAY_EVENT_TYPES = [
  "RunPlanned",
  "FixtureMaterialized",
  "SandboxStarted",
  "AdapterHandshake",
  "ModelRequestStarted",
  "ModelResponseRecorded",
  "ToolCallRecorded",
  "UsageReconciled",
  "UsageUnreconciled",
  "WorkspaceSnapshotTaken",
  "AssertionEvaluated",
  "JudgeVoteRecorded",
  "TrajectoryScored",
  "BudgetEvaluated",
  "TaskRunCompleted",
  "SandboxDestroyed",
  "SuiteCompleted",
  "ComparisonCompleted",
  "RunFailed",
  "RunCancelled"
] as const;

export type AssayEventType = (typeof ASSAY_EVENT_TYPES)[number];

export const TASK_SCOPED_ASSAY_EVENT_TYPES = [
  "FixtureMaterialized",
  "SandboxStarted",
  "AdapterHandshake",
  "ModelRequestStarted",
  "ModelResponseRecorded",
  "ToolCallRecorded",
  "UsageReconciled",
  "UsageUnreconciled",
  "WorkspaceSnapshotTaken",
  "AssertionEvaluated",
  "JudgeVoteRecorded",
  "TrajectoryScored",
  "BudgetEvaluated",
  "TaskRunCompleted",
  "SandboxDestroyed"
] as const satisfies readonly AssayEventType[];

type TaskScopedAssayEventType = (typeof TASK_SCOPED_ASSAY_EVENT_TYPES)[number];
type RunScopedAssayEventType = Exclude<AssayEventType, TaskScopedAssayEventType>;

export interface AssayEventBase<T extends AssayEventType> {
  readonly schema_version: 1;
  readonly type: T;
  readonly run_id: RunId;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type TaskScopedAssayEvent<T extends TaskScopedAssayEventType = TaskScopedAssayEventType> =
  AssayEventBase<T> & { readonly task_run_id: TaskRunId };

export type RunScopedAssayEvent<T extends RunScopedAssayEventType = RunScopedAssayEventType> =
  AssayEventBase<T> & { readonly task_run_id?: never };

export type AssayEvent =
  | { [T in TaskScopedAssayEventType]: TaskScopedAssayEvent<T> }[TaskScopedAssayEventType]
  | { [T in RunScopedAssayEventType]: RunScopedAssayEvent<T> }[RunScopedAssayEventType];

export const MAX_ASSAY_EVENT_BYTES = 1_048_576;

interface AssayEventWire {
  readonly schema_version: 1;
  readonly type: AssayEventType;
  readonly run_id: string;
  readonly task_run_id?: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

const validator = new Ajv({ allErrors: false, strict: true }).compile<AssayEventWire>(eventSchema);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function protocolError(message: string, cause?: unknown): never {
  throw new AssayError(
    "adapter_protocol_error",
    `adapter_protocol_error: ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function decode(input: string | Uint8Array): string {
  const byteLength = typeof input === "string" ? utf8Encoder.encode(input).byteLength : input.byteLength;
  if (byteLength > MAX_ASSAY_EVENT_BYTES) {
    return protocolError(`event exceeds ${MAX_ASSAY_EVENT_BYTES} bytes`);
  }

  if (typeof input === "string") {
    return input;
  }

  try {
    return utf8Decoder.decode(input);
  } catch (cause) {
    return protocolError("event is not valid UTF-8", cause);
  }
}

function isExactUtcMillisecondTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function parseAssayEvent(input: string | Uint8Array): AssayEvent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(decode(input)) as unknown;
  } catch (cause) {
    if (cause instanceof AssayError) {
      throw cause;
    }
    return protocolError("event is not valid JSON", cause);
  }

  if (!validator(candidate)) {
    const first = validator.errors?.[0];
    const location = first?.instancePath === "" ? "$" : (first?.instancePath ?? "$unknown");
    const keyword = first?.keyword ?? "schema";
    return protocolError(`event failed schema at ${location} (${keyword})`);
  }

  if (!isExactUtcMillisecondTimestamp(candidate.timestamp)) {
    return protocolError("event timestamp must be exact RFC 3339 UTC milliseconds");
  }

  try {
    canonicalJson(candidate);
  } catch (cause) {
    return protocolError("event contains a non-canonical JSON value", cause);
  }

  const common = {
    schema_version: 1,
    type: candidate.type,
    run_id: createRunId(candidate.run_id),
    timestamp: candidate.timestamp,
    payload: candidate.payload
  } as const;

  if (candidate.task_run_id === undefined) {
    return common as AssayEvent;
  }

  return { ...common, task_run_id: createTaskRunId(candidate.task_run_id) } as AssayEvent;
}
