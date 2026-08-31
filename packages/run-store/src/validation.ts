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
  "suitePath",
  "suiteContentHash",
  "tasks",
  "variant",
  "configHash",
  "adapterId",
  "adapterVersion",
  "contractVersion",
  "adapterTier",
  "providerReportedModel",
  "rootSeed",
  "harnessVersion",
  "pricingCatalogVersion",
  "runsPerTask",
  "status",
  "isolationLabel"
]);
const RUN_TASK_KEYS = new Set([
  "taskId",
  "taskContentHash",
  "repetitions",
  "rootSeed",
  "seedStrategy",
  "effectiveSeeds"
]);
const VARIANT_KEYS = new Set([
  "name",
  "adapter",
  "model",
  "promptVersion",
  "toolsetVersion",
  "agentVersion"
]);
const MODEL_IDENTITY_KEYS = new Set(["provider", "model", "family"]);
const TASK_RUN_KEYS = new Set([
  "taskRunId",
  "runId",
  "taskId",
  "taskContentHash",
  "repetition",
  "attempt",
  "seed",
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

function boundedSeed(value: unknown, label: string): number {
  const seed = safeInteger(value, label);
  if (seed >= 2 ** 32) {
    return reject(`${label} must be less than 2^32`);
  }
  return seed;
}

function projectRelativePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 4_096);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return reject(`${label} must be a normalized project-relative path`);
  }
  return path;
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
  projectRelativePath(record["suitePath"], "suitePath");
  createContentHash(stringValue(record["suiteContentHash"], "suiteContentHash", 64));
  const tasks = record["tasks"];
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 100_000) {
    reject("tasks must be a non-empty array of at most 100000 identity bindings");
  }
  const taskIds = new Set<string>();
  for (let index = 0; index < tasks.length; index += 1) {
    const label = `tasks[${index}]`;
    const task = objectRecord(tasks[index], label);
    exactKeys(task, RUN_TASK_KEYS, label);
    const taskId = createTaskId(stringValue(task["taskId"], `${label}.taskId`, 63));
    if (taskIds.has(taskId)) {
      reject(`tasks repeats task id ${taskId}`);
    }
    taskIds.add(taskId);
    createContentHash(stringValue(task["taskContentHash"], `${label}.taskContentHash`, 64));
    const repetitions = safeInteger(task["repetitions"], `${label}.repetitions`, 1);
    if (repetitions > 100) {
      reject(`${label}.repetitions must be at most 100`);
    }
    boundedSeed(task["rootSeed"], `${label}.rootSeed`);
    oneOf(task["seedStrategy"], ["derived", "fixed"], `${label}.seedStrategy`);
    const effectiveSeeds = task["effectiveSeeds"];
    if (!Array.isArray(effectiveSeeds) || effectiveSeeds.length !== repetitions) {
      reject(`${label}.effectiveSeeds must contain exactly one seed per repetition`);
    }
    effectiveSeeds.forEach((seed, seedIndex) => {
      stringValue(seed, `${label}.effectiveSeeds[${seedIndex}]`, 128);
    });
  }
  const variant = objectRecord(record["variant"], "variant");
  exactKeys(variant, VARIANT_KEYS, "variant");
  createVariantName(stringValue(variant["name"], "variant.name", 63));
  stringValue(variant["adapter"], "variant.adapter", 128);
  stringValue(variant["model"], "variant.model", 256);
  nullableString(variant["promptVersion"], "variant.promptVersion", 256);
  nullableString(variant["toolsetVersion"], "variant.toolsetVersion", 256);
  nullableString(variant["agentVersion"], "variant.agentVersion", 256);
  createContentHash(stringValue(record["configHash"], "configHash", 64));
  stringValue(record["adapterId"], "adapterId", 128);
  stringValue(record["adapterVersion"], "adapterVersion", 128);
  if (record["contractVersion"] !== "assay-adapter/1") {
    reject("contractVersion must be assay-adapter/1");
  }
  oneOf(record["adapterTier"], ["full", "trajectory", "black_box"], "adapterTier");
  if (record["providerReportedModel"] !== null) {
    const model = objectRecord(record["providerReportedModel"], "providerReportedModel");
    exactKeys(model, MODEL_IDENTITY_KEYS, "providerReportedModel");
    stringValue(model["provider"], "providerReportedModel.provider", 128);
    stringValue(model["model"], "providerReportedModel.model", 256);
    stringValue(model["family"], "providerReportedModel.family", 128);
  }
  boundedSeed(record["rootSeed"], "rootSeed");
  stringValue(record["harnessVersion"], "harnessVersion", 128);
  stringValue(record["pricingCatalogVersion"], "pricingCatalogVersion", 128);
  safeInteger(record["runsPerTask"], "runsPerTask", 1);
  oneOf(record["status"], ["in_progress", "completed", "failed", "cancelled"], "status");
  oneOf(
    record["isolationLabel"],
    ["isolated", "network_allowlisted", "unsafe_host"],
    "isolationLabel"
  );
  return record as unknown as RunRecord;
}

export function validateTaskRunRecordJson(recordJson: string): TaskRunRecord {
  const record = objectRecord(parseBoundedCanonicalJson(recordJson), "task-run record");
  exactKeys(record, TASK_RUN_KEYS, "task-run record");
  createTaskRunId(stringValue(record["taskRunId"], "taskRunId", 36));
  createRunId(stringValue(record["runId"], "runId", 36));
  createTaskId(stringValue(record["taskId"], "taskId", 63));
  createContentHash(stringValue(record["taskContentHash"], "taskContentHash", 64));
  safeInteger(record["repetition"], "repetition");
  safeInteger(record["attempt"], "attempt");
  stringValue(record["seed"], "seed", 128);
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
