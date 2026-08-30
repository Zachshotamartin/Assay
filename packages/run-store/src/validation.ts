import {
  ASSAY_ERROR_CATEGORIES,
  TASK_RUN_STATES,
  canonicalJson,
  createBlobHash,
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  createVariantName,
  type AssertionResult,
  type RunRecord,
  type TaskRunRecord,
  type UsageRecord
} from "@assay/contracts";

import { MAX_RECORD_JSON_BYTES } from "./types.js";

const encoder = new TextEncoder();
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RUN_KEYS = new Set([
  "runId",
  "createdAtUtc",
  "suiteHash",
  "variant",
  "adapterId",
  "adapterVersion",
  "modelId",
  "seed",
  "harnessVersion",
  "runsPerTask",
  "status",
  "isolation"
]);
const TASK_RUN_KEYS = new Set([
  "taskRunId",
  "runId",
  "taskId",
  "taskContentHash",
  "attempt",
  "state",
  "outcome",
  "errorCategory",
  "trajectoryBlob",
  "workspaceSnapshot",
  "assertionResults",
  "usage",
  "startedAtUtc",
  "endedAtUtc"
]);
const ASSERTION_KEYS = new Set([
  "type",
  "target",
  "observed",
  "expectation",
  "verdict",
  "durationMs",
  "errorCategory",
  "message"
]);
const USAGE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "providerReportedCostUsd",
  "catalogEstimatedCostUsd",
  "reconciliation",
  "providerLatencyMs",
  "toolLatencyMs",
  "harnessOverheadMs"
]);

export class StoredRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredRecordValidationError";
  }
}

function reject(reason: string): never {
  throw new StoredRecordValidationError(reason);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      reject(`${label} contains unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key) && key !== "errorCategory" && key !== "message") {
      reject(`${label} is missing field ${JSON.stringify(key)}`);
    }
  }
}

function stringValue(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    return reject(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maximum = 1_024): string | null {
  return value === null ? null : stringValue(value, label, maximum);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return reject(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function finiteNumberOrNull(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return reject(`${label} must be null or a finite non-negative number`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const candidate = stringValue(value, label, 24);
  if (!EXACT_TIMESTAMP.test(candidate)) {
    return reject(`${label} must use exact RFC 3339 UTC milliseconds`);
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== candidate) {
    return reject(`${label} is not a valid UTC timestamp`);
  }
  return candidate;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return reject(`${label} is not an allowed value`);
  }
  return value as T;
}

function validateAssertion(value: unknown, index: number): AssertionResult {
  const label = `assertionResults[${index}]`;
  const record = objectRecord(value, label);
  exactKeys(record, ASSERTION_KEYS, label);
  stringValue(record["type"], `${label}.type`, 128);
  stringValue(record["target"], `${label}.target`, 262_144);
  try {
    canonicalJson(record["observed"]);
    canonicalJson(record["expectation"]);
  } catch {
    reject(`${label}.observed and expectation must be canonical JSON values`);
  }
  oneOf(record["verdict"], ["pass", "fail", "error"], `${label}.verdict`);
  safeInteger(record["durationMs"], `${label}.durationMs`);
  const errorCategory = record["errorCategory"];
  const message = record["message"];
  if (
    errorCategory !== undefined &&
    (typeof errorCategory !== "string" ||
      !(ASSAY_ERROR_CATEGORIES as readonly string[]).includes(errorCategory))
  ) {
    reject(`${label}.errorCategory is not an Assay error category`);
  }
  if (message !== undefined) {
    stringValue(message, `${label}.message`, 262_144);
  }

  return record as unknown as AssertionResult;
}

function validateUsage(value: unknown): UsageRecord {
  const record = objectRecord(value, "usage");
  exactKeys(record, USAGE_KEYS, "usage");
  safeInteger(record["inputTokens"], "usage.inputTokens");
  safeInteger(record["outputTokens"], "usage.outputTokens");
  finiteNumberOrNull(record["providerReportedCostUsd"], "usage.providerReportedCostUsd");
  finiteNumberOrNull(record["catalogEstimatedCostUsd"], "usage.catalogEstimatedCostUsd");
  oneOf(record["reconciliation"], ["reconciled", "unreconciled", "synthetic"], "usage.reconciliation");
  safeInteger(record["providerLatencyMs"], "usage.providerLatencyMs");
  safeInteger(record["toolLatencyMs"], "usage.toolLatencyMs");
  safeInteger(record["harnessOverheadMs"], "usage.harnessOverheadMs");
  return record as unknown as UsageRecord;
}

function parseBoundedCanonicalJson(recordJson: string): unknown {
  if (encoder.encode(recordJson).byteLength > MAX_RECORD_JSON_BYTES) {
    return reject(`record exceeds ${MAX_RECORD_JSON_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson) as unknown;
  } catch {
    return reject("record is not valid JSON");
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    return reject("record contains a value outside canonical JSON");
  }
  if (canonical !== recordJson) {
    return reject("record JSON is not in canonical form");
  }
  return parsed;
}

export function validateRunRecordJson(recordJson: string): RunRecord {
  const record = objectRecord(parseBoundedCanonicalJson(recordJson), "run record");
  exactKeys(record, RUN_KEYS, "run record");
  createRunId(stringValue(record["runId"], "runId", 36));
  timestamp(record["createdAtUtc"], "createdAtUtc");
  createContentHash(stringValue(record["suiteHash"], "suiteHash", 64));
  createVariantName(stringValue(record["variant"], "variant", 63));
  stringValue(record["adapterId"], "adapterId", 128);
  stringValue(record["adapterVersion"], "adapterVersion", 128);
  nullableString(record["modelId"], "modelId", 256);
  safeInteger(record["seed"], "seed", Number.MIN_SAFE_INTEGER);
  stringValue(record["harnessVersion"], "harnessVersion", 128);
  safeInteger(record["runsPerTask"], "runsPerTask", 1);
  oneOf(record["status"], ["in_progress", "completed", "failed", "cancelled"], "status");
  oneOf(record["isolation"], ["container", "unsafe_host"], "isolation");
  return record as unknown as RunRecord;
}

export function validateTaskRunRecordJson(recordJson: string): TaskRunRecord {
  const record = objectRecord(parseBoundedCanonicalJson(recordJson), "task-run record");
  exactKeys(record, TASK_RUN_KEYS, "task-run record");
  createTaskRunId(stringValue(record["taskRunId"], "taskRunId", 36));
  createRunId(stringValue(record["runId"], "runId", 36));
  createTaskId(stringValue(record["taskId"], "taskId", 63));
  createContentHash(stringValue(record["taskContentHash"], "taskContentHash", 64));
  safeInteger(record["attempt"], "attempt");
  oneOf(record["state"], TASK_RUN_STATES, "state");
  if (record["outcome"] !== null) {
    oneOf(record["outcome"], ["pass", "fail", "error"], "outcome");
  }
  nullableString(record["errorCategory"], "errorCategory", 128);
  if (record["trajectoryBlob"] !== null) {
    createBlobHash(stringValue(record["trajectoryBlob"], "trajectoryBlob", 64));
  }
  if (record["workspaceSnapshot"] !== null) {
    createBlobHash(stringValue(record["workspaceSnapshot"], "workspaceSnapshot", 64));
  }
  const assertions = record["assertionResults"];
  if (!Array.isArray(assertions) || assertions.length > 10_000) {
    reject("assertionResults must be an array of at most 10000 entries");
  }
  assertions.forEach(validateAssertion);
  if (record["usage"] !== null) {
    validateUsage(record["usage"]);
  }
  timestamp(record["startedAtUtc"], "startedAtUtc");
  nullableTimestamp(record["endedAtUtc"], "endedAtUtc");
  return record as unknown as TaskRunRecord;
}
