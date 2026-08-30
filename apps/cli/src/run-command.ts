import { createHash } from "node:crypto";

import {
  createHostCommandRunner,
  createSystemDeadlineScheduler,
  evaluateCheckerAssertion,
  evaluateDeterministicAssertion,
  type AssertionResult,
  type CheckerAssertionSpec,
  type CheckerTaskDefinition,
  type DeterministicAssertionSpec
} from "@assay/assertions";
import {
  encodeAdapterEventFrame,
  parseAdapterEventFrame,
  superviseAdapter,
  type AdapterCaptureRedactor,
  type AdapterEvent,
  type AdapterSupervisionResult
} from "@assay/adapter-core";
import {
  aggregateExitCode,
  ASSAY_ERROR_CATEGORIES,
  AssayError,
  canonicalJson,
  canonicalJsonBytes,
  createContentHash,
  createTaskId,
  createVariantName,
  exitCodeForCategory,
  parseAssayEvent,
  type AssayErrorCategory,
  type AssayEvent,
  type ExitCode,
  type IdSource,
  type TaskRunId,
  type TaskRunState,
  type UsageRecord
} from "@assay/contracts";
import {
  createJsonRedactionSession,
  createUtf8RedactionSession,
  redactJsonDeep,
  REDACTION_RULESET_VERSION,
  type JsonValue,
  type RedactionManifest
} from "@assay/redaction";
import { openRunStore, type RunStore } from "@assay/run-store";
import {
  executeTaskRun,
  runTaskRunsSequentially,
  type TaskRunLifecycle
} from "@assay/runner";

import {
  resolveRuntimeConfig,
  suiteDeclaresAnyBudget,
  suiteDeclaresDollarBudget,
  suiteRunPolicy,
  taskRunPolicy,
  taskTags,
  variantDefinition,
  type LoadedConfigInput,
  type PreparedAssertion,
  type PreparedSuite,
  type PreparedTask
} from "./project.js";
import type { CliIo } from "./cli.js";
import type { AdapterCommand, CliRuntime } from "./runtime.js";
import {
  destroyWorkspace,
  materializeFixture,
  snapshotWorkspace,
  type MaterializedWorkspace
} from "./workspace.js";

const HARNESS_VERSION = "0.0.0";
const UNSAFE_BANNER =
  "WARNING: UNSAFE HOST EXECUTION — this run has no filesystem, network, CPU, memory, or process isolation.\n";

export interface RunInvocation {
  readonly suitePath: string;
  readonly variant: string;
  readonly runsPerTask?: number;
  readonly adapter?: string;
  readonly seed?: number;
  readonly dryRun?: true;
  readonly unsafeHostExec?: true;
}

interface PlannedTaskRun {
  readonly task: PreparedTask;
  readonly repetition: number;
  readonly rootSeed: number;
  readonly seedStrategy: SeedStrategy;
  readonly seed: string;
  readonly taskRunId: TaskRunId;
}

type SeedStrategy = "derived" | "fixed";

interface TaskExecutionPolicy {
  readonly task: PreparedTask;
  readonly repetitions: number;
  readonly rootSeed: number;
  readonly seedStrategy: SeedStrategy;
  readonly effectiveSeeds: readonly string[];
}

interface AdapterCollection {
  readonly result: AdapterSupervisionResult;
  readonly events: readonly AdapterEvent[];
  readonly eventManifests: readonly RedactionManifest[];
}

interface TaskEvidence {
  readonly workspace: MaterializedWorkspace;
  readonly collection: AdapterCollection;
  readonly trajectoryBytes: Uint8Array;
  readonly snapshotBytes: Uint8Array;
  assertionResults: readonly AssertionResult[];
}

interface TaskExecutionResult {
  readonly lifecycle: TaskRunLifecycle;
  readonly history: readonly TaskRunLifecycle[];
}

class ReplayingIdSource<T extends string> implements IdSource<T> {
  readonly #upstream: IdSource<T>;
  readonly #reserved: T[] = [];

  constructor(upstream: IdSource<T>) {
    this.#upstream = upstream;
  }

  reserve(): T {
    const value = this.#upstream.next();
    this.#reserved.push(value);
    return value;
  }

  next(): T {
    return this.#reserved.shift() ?? this.#upstream.next();
  }
}

function normalizedAdapterId(value: unknown): string {
  if (value === "simulated" || value === "adapter-simulated") return "adapter-simulated";
  throw new AssayError(
    "adapter_unavailable",
    `adapter_unavailable: adapter ${JSON.stringify(value)} is not available in R1; no run record or provider activity occurred; use adapter-simulated`
  );
}

function deriveSeed(rootSeed: number, taskContentHash: string, repetition: number): string {
  return createHash("sha256")
    .update(canonicalJsonBytes({ repetition, rootSeed, taskContentHash }))
    .digest("hex")
    .slice(0, 16);
}

function optionalPolicyInteger(
  policy: Readonly<Record<string, unknown>>,
  field: "n" | "seed",
  owner: string
): number | undefined {
  const value = policy[field];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new AssayError(
    "internal_invariant",
    `internal_invariant: validated ${owner} run_policy.${field} was not an integer`
  );
}

function taskSeedStrategy(policy: Readonly<Record<string, unknown>>, taskId: string): SeedStrategy {
  const value = policy["seed_strategy"];
  if (value === undefined || value === "derived") return "derived";
  if (value === "fixed") return "fixed";
  throw new AssayError(
    "internal_invariant",
    `internal_invariant: validated task ${taskId} run_policy.seed_strategy was unsupported`
  );
}

function resolveTaskExecutionPolicies(
  suite: PreparedSuite,
  globalRunsOverride: number | undefined,
  configuredRunsDefault: number,
  invocationSeed: number | undefined
): readonly TaskExecutionPolicy[] {
  const suitePolicy = suiteRunPolicy(suite);
  const suiteRuns = optionalPolicyInteger(suitePolicy, "n", `suite ${suite.source.suite.document["id"]}`);
  return suite.tasks.map((task) => {
    const policy = taskRunPolicy(task);
    const repetitions = globalRunsOverride ??
      optionalPolicyInteger(policy, "n", `task ${task.id}`) ??
      suiteRuns ??
      configuredRunsDefault;
    const rootSeed = invocationSeed ?? optionalPolicyInteger(policy, "seed", `task ${task.id}`) ?? 0;
    const seedStrategy = taskSeedStrategy(policy, task.id);
    return {
      task,
      repetitions,
      rootSeed,
      seedStrategy,
      effectiveSeeds: Array.from({ length: repetitions }, (_, repetition) => deriveSeed(
        rootSeed,
        task.source.contentHash,
        seedStrategy === "fixed" ? 0 : repetition
      ))
    };
  });
}

function resultWithoutCheckerExtensions(result: AssertionResult): AssertionResult {
  return {
    type: result.type,
    target: result.target,
    observed: result.observed,
    expectation: result.expectation,
    verdict: result.verdict,
    durationMs: result.durationMs,
    ...(result.errorCategory === undefined ? {} : { errorCategory: result.errorCategory }),
    ...(result.message === undefined ? {} : { message: result.message })
  };
}

function adapterRedactor(knownHashes: ReadonlySet<string>): AdapterCaptureRedactor {
  const adapterEventTypes = new Set<AdapterEvent["type"]>([
    "session_started", "model_request", "model_response", "tool_call", "tool_result",
    "usage", "text_output", "run_completed", "run_failed", "log"
  ]);
  return {
    redactJson(value) {
      // Valid event frames are released only to the bounded, semantic batch below.
      // Redacting each fragment here would destroy the context needed to detect a
      // provider credential split over multiple otherwise-valid frames.
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const record = value as Readonly<Record<string, unknown>>;
        const type = record["type"];
        if (typeof type === "string" && adapterEventTypes.has(type as AdapterEvent["type"]) &&
            typeof record["seq"] === "number") {
          return value;
        }
      }
      return redactJsonDeep(value, { location: "/adapter", knownHashes }).value;
    },
    redactBytes(bytes) {
      const session = createUtf8RedactionSession({ location: "/adapter/stderr", knownHashes });
      session.write(bytes);
      return new TextDecoder("utf-8", { fatal: true }).decode(session.finish().value);
    }
  };
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function stringLeafPointers(value: unknown, pointer: string): readonly string[] {
  if (typeof value === "string") return [pointer];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => stringLeafPointers(entry, `${pointer}/${index}`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value as Readonly<Record<string, unknown>>)
    .sort()
    .flatMap((key) => stringLeafPointers(
      (value as Readonly<Record<string, unknown>>)[key],
      `${pointer}/${escapeJsonPointerSegment(key)}`
    ));
}

function unreachableAdapterEvent(value: never): never {
  throw new AssayError(
    "redaction_failed",
    "redaction_failed: adapter event continuation mapping is incomplete for a validated event"
  );
}

export function adapterContinuationLocations(event: AdapterEvent): readonly string[] {
  switch (event.type) {
    case "session_started":
    case "model_request":
    case "usage":
      return [];
    case "model_response":
      return event.text === null ? [] : ["/text"];
    case "tool_call":
      return stringLeafPointers(event.args, "/args");
    case "tool_result":
      return ["/result"];
    case "text_output":
      return ["/text"];
    case "run_completed":
      return ["/summary"];
    case "run_failed":
    case "log":
      return ["/message"];
    default:
      return unreachableAdapterEvent(event);
  }
}

function validatedRedactedAdapterEvent(value: unknown, expectedType: AdapterEvent["type"]): AdapterEvent {
  try {
    const parsed = parseAdapterEventFrame(encodeAdapterEventFrame(value as AdapterEvent));
    if (parsed.type !== expectedType) {
      throw new Error(`event type changed from ${expectedType} to ${parsed.type}`);
    }
    return parsed;
  } catch (cause) {
    throw new AssayError(
      "redaction_failed",
      "redaction_failed: semantic redaction invalidated a validated adapter event; no event was persisted",
      { cause }
    );
  }
}

function subjectProjection(event: AdapterEvent): JsonValue {
  switch (event.type) {
    case "session_started":
    case "model_request":
    case "usage":
      return {};
    case "model_response":
      return { text: event.text };
    case "tool_call":
      return { args: event.args as JsonValue };
    case "tool_result":
      return { result: event.result };
    case "text_output":
      return { text: event.text };
    case "run_completed":
      return { summary: event.summary };
    case "run_failed":
    case "log":
      return { message: event.message };
    default:
      return unreachableAdapterEvent(event);
  }
}

function metadataProjection(event: AdapterEvent): AdapterEvent {
  switch (event.type) {
    case "session_started":
    case "model_request":
    case "usage":
      return event;
    case "model_response":
      return { ...event, text: event.text === null ? null : "" };
    case "tool_call":
      return { ...event, args: {} };
    case "tool_result":
      return { ...event, result: "" };
    case "text_output":
      return { ...event, text: "" };
    case "run_completed":
      return { ...event, summary: "" };
    case "run_failed":
    case "log":
      return { ...event, message: "" };
    default:
      return unreachableAdapterEvent(event);
  }
}

function projectionRecord(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AssayError(
      "redaction_failed",
      "redaction_failed: subject projection redaction returned a non-object"
    );
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function projectedString(
  projection: Readonly<Record<string, JsonValue>>,
  key: string,
  nullable = false
): string | null {
  const value = projection[key];
  if (typeof value === "string" || (nullable && value === null)) return value as string | null;
  throw new AssayError(
    "redaction_failed",
    `redaction_failed: subject projection invalidated ${key}`
  );
}

function applySubjectProjection(base: AdapterEvent, value: JsonValue): AdapterEvent {
  const projection = projectionRecord(value);
  switch (base.type) {
    case "session_started":
    case "model_request":
    case "usage":
      return base;
    case "model_response":
      return { ...base, text: projectedString(projection, "text", true) };
    case "tool_call": {
      const args = projection["args"];
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new AssayError("redaction_failed", "redaction_failed: subject projection invalidated tool args");
      }
      return { ...base, args: args as Readonly<Record<string, unknown>> };
    }
    case "tool_result":
      return { ...base, result: projectedString(projection, "result")! };
    case "text_output":
      return { ...base, text: projectedString(projection, "text")! };
    case "run_completed":
      return { ...base, summary: projectedString(projection, "summary")! };
    case "run_failed":
    case "log":
      return { ...base, message: projectedString(projection, "message")! };
    default:
      return unreachableAdapterEvent(base);
  }
}

function mergeRedactionManifests(
  first: RedactionManifest,
  second: RedactionManifest
): RedactionManifest {
  const applied = [...first.applied, ...second.applied];
  const counts = new Map<string, number>();
  for (const entry of applied) counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + entry.count);
  return {
    rulesetVersion: REDACTION_RULESET_VERSION,
    redactionCount: applied.reduce((total, entry) => total + entry.count, 0),
    matchCounts: Object.fromEntries([...counts].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)),
    applied
  };
}

function persistedSubjectManifest(manifest: RedactionManifest, index: number): RedactionManifest {
  const projectionRoot = "/trajectory/events";
  const applied = manifest.applied.map((entry) => {
    if (entry.location !== projectionRoot && !entry.location.startsWith(`${projectionRoot}/`)) {
      throw new AssayError(
        "redaction_failed",
        "redaction_failed: subject manifest escaped its bounded projection root"
      );
    }
    return {
      ...entry,
      location: `${projectionRoot}/${index}${entry.location.slice(projectionRoot.length)}`
    };
  });
  return {
    ...manifest,
    applied
  };
}

export function redactAdapterEventBatch(
  events: readonly AdapterEvent[],
  knownHashes: ReadonlySet<string>
): { readonly events: readonly AdapterEvent[]; readonly manifests: readonly RedactionManifest[] } {
  const eventKnownHashes = new Set(knownHashes);
  for (const event of events) {
    if (event.type === "model_request") eventKnownHashes.add(event.inputSummarySha256);
    if ("originalSha256" in event && event.originalSha256 !== undefined) {
      eventKnownHashes.add(event.originalSha256);
    }
  }
  const individuallyRedacted = events.map((event, index) => {
    const result = redactJsonDeep(metadataProjection(event), {
      location: `/trajectory/events/${index}`,
      knownHashes: eventKnownHashes
    });
    return {
      event: validatedRedactedAdapterEvent(result.value, event.type),
      manifest: result.manifest
    };
  });
  const session = createJsonRedactionSession({
    // The subject projection mirrors the corresponding persisted event fields,
    // so its manifest locations remain truthful pointers into the trajectory.
    location: "/trajectory/events",
    knownHashes: eventKnownHashes
  });
  for (const event of events) {
    session.write(subjectProjection(event), adapterContinuationLocations(event));
  }
  const output = session.finish();
  return {
    events: output.map((entry, index) => validatedRedactedAdapterEvent(
      applySubjectProjection(individuallyRedacted[index]!.event, entry.value),
      events[index]!.type
    )),
    manifests: output.map((entry, index) => mergeRedactionManifests(
      individuallyRedacted[index]!.manifest,
      persistedSubjectManifest(entry.manifest, index)
    ))
  };
}

function trajectoryBytes(
  plan: PlannedTaskRun,
  collection: AdapterCollection,
  knownHashes: ReadonlySet<string>
): Uint8Array {
  const diagnosticsSession = createJsonRedactionSession({
    location: "/trajectory/diagnostics",
    knownHashes
  });
  for (const diagnostic of collection.result.diagnostics) {
    diagnosticsSession.write(diagnostic);
  }
  const diagnostics = diagnosticsSession.finish().map((entry) => entry.value);
  return canonicalJsonBytes({
    trajectoryVersion: 1,
    redactionRulesetVersion: REDACTION_RULESET_VERSION,
    taskRunId: plan.taskRunId,
    taskId: plan.task.id,
    taskContentHash: plan.task.source.contentHash,
    repetition: plan.repetition,
    rootSeed: plan.rootSeed,
    seedStrategy: plan.seedStrategy,
    effectiveSeed: plan.seed,
    descriptor: collection.result.descriptor,
    events: collection.events,
    eventRedactionManifests: collection.eventManifests,
    diagnostics,
    stderr: collection.result.stderr,
    malformedFrameCount: collection.result.malformedFrameCount,
    defensiveTruncations: collection.result.defensiveTruncations,
    incomplete: collection.result.incomplete,
    incompleteReasons: collection.result.incompleteReasons,
    exit: collection.result.exit,
    termination: collection.result.termination
  });
}

function usageFrom(events: readonly AdapterEvent[]): UsageRecord | null {
  const usages = events.filter((event): event is Extract<AdapterEvent, { readonly type: "usage" }> =>
    event.type === "usage");
  if (usages.length === 0) return null;
  const responses = events.filter((event): event is Extract<AdapterEvent, { readonly type: "model_response" }> =>
    event.type === "model_response");
  const tools = events.filter((event): event is Extract<AdapterEvent, { readonly type: "tool_result" }> =>
    event.type === "tool_result");
  return {
    inputTokens: usages.reduce((sum, event) => sum + event.usage.promptTokens, 0),
    outputTokens: usages.reduce((sum, event) => sum + event.usage.completionTokens, 0),
    providerReportedCostUsd: usages.reduce((sum, event) => sum + (event.usage.costUsdMicros ?? 0), 0) / 1_000_000,
    catalogEstimatedCostUsd: null,
    reconciliation: usages.every((event) => event.usage.source === "synthetic") ? "synthetic" : "unreconciled",
    providerLatencyMs: responses.reduce((sum, event) => sum + event.latencyMs, 0),
    toolLatencyMs: tools.reduce((sum, event) => sum + event.durationMs, 0),
    harnessOverheadMs: 0
  };
}

function taskDefinition(task: PreparedTask): CheckerTaskDefinition {
  return {
    formatVersion: "1.0",
    id: task.id,
    title: task.title,
    tags: taskTags(task),
    fixture: task.source.document["fixture"],
    prompt: task.prompt,
    toolset: task.source.document["toolset"],
    sandbox: task.source.document["sandbox"],
    assertions: task.assertions
  };
}

function safeCommandEnvironment(
  runtime: CliRuntime,
  task: PreparedTask
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: runtime.environment["PATH"] ?? "/usr/bin:/bin",
    ...task.environment
  });
}

async function evaluateAssertions(
  plan: PlannedTaskRun,
  evidence: TaskEvidence,
  runtime: CliRuntime,
  knownHashes: ReadonlySet<string>,
  signal: AbortSignal
): Promise<"pass" | "fail"> {
  const commandRunner = await createHostCommandRunner({
    workspaceRoot: evidence.workspace.workspaceRoot,
    environment: safeCommandEnvironment(runtime, plan.task),
    deadlineScheduler: createSystemDeadlineScheduler()
  });
  const results: AssertionResult[] = [];
  for (const assertion of plan.task.assertions) {
    if (assertion.type === "checker") {
      const checker = await evaluateCheckerAssertion(assertion, {
        projectRoot: runtime.projectRoot,
        workspaceRoot: evidence.workspace.workspaceRoot,
        task: taskDefinition(plan.task),
        trajectory: evidence.collection.events,
        clock: runtime.clock,
        deadlineScheduler: createSystemDeadlineScheduler()
      }, signal);
      results.push(resultWithoutCheckerExtensions(checker));
    } else {
      results.push(await evaluateDeterministicAssertion(assertion, {
        workspaceRoot: evidence.workspace.workspaceRoot,
        fixtureRoot: evidence.workspace.fixtureRoot,
        projectRoot: runtime.projectRoot,
        sandboxWorkdir: "/workspace",
        agentExitCode: evidence.collection.result.exit.code,
        clock: runtime.clock,
        commandRunner
      }, signal));
    }
  }

  const redaction = createJsonRedactionSession({
    location: "/assertionResults",
    knownHashes
  });
  for (const result of results) {
    redaction.write(result, [
      ...stringLeafPointers(result.observed, "/observed"),
      ...stringLeafPointers(result.expectation, "/expectation"),
      ...(result.message === undefined ? [] : ["/message"])
    ]);
  }
  evidence.assertionResults = redaction.finish().map((entry) => {
    const value = entry.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AssayError("redaction_failed", "redaction_failed: assertion redaction returned a non-object");
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (typeof record["type"] !== "string" || typeof record["target"] !== "string" ||
        (record["verdict"] !== "pass" && record["verdict"] !== "fail" && record["verdict"] !== "error") ||
        typeof record["durationMs"] !== "number" ||
        (record["message"] !== undefined && typeof record["message"] !== "string") ||
        (record["errorCategory"] !== undefined &&
          !ASSAY_ERROR_CATEGORIES.includes(record["errorCategory"] as AssayErrorCategory))) {
      throw new AssayError(
        "redaction_failed",
        "redaction_failed: assertion redaction invalidated a validated assertion result"
      );
    }
    return value as unknown as AssertionResult;
  });
  if (evidence.assertionResults.some((result) => result.verdict === "error")) {
    throw new AssayError(
      "assertion_error",
      "assertion_error: one or more assertions could not be evaluated; redacted evidence will persist; inspect the assertion result and fix the checker or command"
    );
  }
  return evidence.assertionResults.some((result) => result.verdict === "fail")
    ? "fail"
    : "pass";
}

function event(
  type: AssayEvent["type"],
  runId: AssayEvent["run_id"],
  timestamp: string,
  payload: Readonly<Record<string, unknown>>,
  taskRunId?: TaskRunId
): AssayEvent {
  return {
    schema_version: 1,
    type,
    run_id: runId,
    timestamp,
    payload,
    ...(taskRunId === undefined ? {} : { task_run_id: taskRunId })
  } as AssayEvent;
}

function assayEventsForTask(
  runId: AssayEvent["run_id"],
  plan: PlannedTaskRun,
  evidence: TaskEvidence | undefined,
  lifecycle: TaskRunLifecycle,
  isolation: "isolated" | "network_allowlisted" | "unsafe_host",
  timestamp: string
): readonly AssayEvent[] {
  const events: AssayEvent[] = [];
  if (evidence !== undefined) {
    events.push(event(
      "FixtureMaterialized",
      runId,
      timestamp,
      { fixtureKind: plan.task.fixture.kind },
      plan.taskRunId
    ));
    if (isolation !== "unsafe_host") {
      events.push(event("SandboxStarted", runId, timestamp, { isolation }, plan.taskRunId));
    }
    if (evidence.collection.result.descriptor !== null) {
      events.push(event("AdapterHandshake", runId, timestamp, {
        descriptor: evidence.collection.result.descriptor
      }, plan.taskRunId));
    }
    for (const adapterEvent of evidence.collection.events) {
      const type = adapterEvent.type === "model_request"
        ? "ModelRequestStarted"
        : adapterEvent.type === "model_response"
          ? "ModelResponseRecorded"
          : adapterEvent.type === "tool_call" || adapterEvent.type === "tool_result"
            ? "ToolCallRecorded"
            : adapterEvent.type === "usage"
              ? "UsageReconciled"
              : null;
      if (type !== null) {
        events.push(event(type, runId, timestamp, { adapterEvent }, plan.taskRunId));
      }
    }
    events.push(event("WorkspaceSnapshotTaken", runId, timestamp, {}, plan.taskRunId));
    for (const result of evidence.assertionResults) {
      events.push(event("AssertionEvaluated", runId, timestamp, { result }, plan.taskRunId));
    }
  }
  if (lifecycle.state === "scored") {
    events.push(event("TaskRunCompleted", runId, timestamp, {
      outcome: lifecycle.outcome,
      taskContentHash: plan.task.source.contentHash,
      repetition: plan.repetition,
      rootSeed: plan.rootSeed,
      seedStrategy: plan.seedStrategy,
      effectiveSeed: plan.seed
    }, plan.taskRunId));
  }
  if (evidence !== undefined && isolation !== "unsafe_host") {
    events.push(event("SandboxDestroyed", runId, timestamp, { isolation }, plan.taskRunId));
  }
  return events;
}

async function appendEventBatch(
  store: RunStore,
  runId: AssayEvent["run_id"],
  events: readonly AssayEvent[],
  sequence: { value: number }
): Promise<void> {
  // Every subject-controlled payload admitted here has already crossed its
  // schema-specific bounded redaction session. Re-scanning the containing
  // event would treat immutable UUIDs and derived seeds as entropy secrets and
  // invalidate the event schema.
  for (const item of events) {
    let validated: AssayEvent;
    try {
      validated = parseAssayEvent(canonicalJson(item));
    } catch (cause) {
      throw new AssayError(
        "redaction_failed",
        "redaction_failed: event redaction invalidated a validated Assay event",
        { cause }
      );
    }
    await store.appendEvent(runId, sequence.value, validated);
    sequence.value += 1;
  }
}

function persistedState(lifecycle: TaskRunLifecycle): TaskRunState {
  return lifecycle.state === "scored" ? "completed" : lifecycle.state;
}

function categoryError(category: AssayErrorCategory): AssayError {
  return new AssayError(
    category,
    `${category}: the R1 task-run pipeline ended as infrastructure error; durable redacted settlement was attempted; inspect the stored run and correct the named subsystem`
  );
}

function dryRunPlan(
  invocation: RunInvocation,
  suite: PreparedSuite,
  adapter: string,
  configuredRunsPerTask: number,
  invocationRootSeed: number,
  taskPolicies: readonly TaskExecutionPolicy[],
  configHash: string,
  pricingCatalogVersion: string
): Readonly<Record<string, unknown>> {
  return {
    command: "run",
    dryRun: true,
    suitePath: invocation.suitePath,
    suiteContentHash: suite.source.suiteContentHash,
    variant: invocation.variant,
    adapter,
    runsPerTask: configuredRunsPerTask,
    rootSeed: invocationRootSeed,
    isolation: "unsafe_host",
    pricingCatalogVersion,
    estimatedSpendCeilingUsd: 0,
    configHash,
    tasks: taskPolicies.map((policy) => ({
      id: policy.task.id,
      contentHash: policy.task.source.contentHash,
      repetitions: policy.repetitions,
      rootSeed: policy.rootSeed,
      seedStrategy: policy.seedStrategy,
      effectiveSeeds: policy.effectiveSeeds
    }))
  };
}

export async function executeRunCommand(
  invocation: RunInvocation,
  suite: PreparedSuite,
  configInput: LoadedConfigInput,
  runtime: CliRuntime,
  io: CliIo
): Promise<ExitCode> {
  const variant = variantDefinition(suite, invocation.variant);
  const taskNetworkAllowlist = suite.tasks.some((task) => task.networkAllowlist);
  const resolvedConfig = resolveRuntimeConfig(runtime, configInput, {
    ...(invocation.runsPerTask === undefined ? {} : { runsPerTask: invocation.runsPerTask }),
    ...(invocation.adapter === undefined ? {} : { defaultAdapter: invocation.adapter })
  }, {
    ...(invocation.unsafeHostExec === true ? { unsafeHostExec: true } : {}),
    ...(taskNetworkAllowlist ? { taskNetworkAllowlist: true } : {}),
    ...(suiteDeclaresDollarBudget(suite) ? { declaredDollarBudget: true } : {})
  });
  const configuredRunsPerTask = resolvedConfig.config.runsPerTask;
  const invocationRootSeed = invocation.seed ?? 0;
  const taskPolicies = resolveTaskExecutionPolicies(
    suite,
    resolvedConfig.sources.runsPerTask.kind === "default" ? undefined : configuredRunsPerTask,
    configuredRunsPerTask,
    invocation.seed
  );
  const variantAdapter = variant["adapter"];
  const selectedAdapter = invocation.adapter ?? variantAdapter ?? resolvedConfig.config.defaultAdapter;
  const adapter = normalizedAdapterId(selectedAdapter);
  const model = typeof variant["model"] === "string" ? variant["model"] : null;

  if (suiteDeclaresAnyBudget(suite)) {
    throw new AssayError(
      "suite_invalid",
      "suite_invalid: budget execution is deferred until R5; nothing ran; validation accepts the versioned declaration, but R1 cannot execute it without silently ignoring a gate"
    );
  }

  if (suite.tasks.some((task) => task.fixture.gitInit)) {
    throw new AssayError(
      "sandbox_unavailable",
      "sandbox_unavailable: deterministic git_init constants and enforcement are owned by the R2 packages/sandbox boundary; no workspace, store, or adapter activity occurred; validate succeeds, but R1 will not silently initialize Git with host defaults"
    );
  }

  const commandAssertions = suite.tasks.some((task) =>
    task.assertions.some((assertion) => assertion.type === "tests_pass" || assertion.type === "command_output"));
  if (commandAssertions && invocation.unsafeHostExec !== true) {
    throw new AssayError(
      "invalid_invocation",
      "invalid_invocation: tests_pass and command_output require --unsafe-host-exec in R1; no command, adapter, or store activity occurred; review the persistent unsafe-mode consequences and add the flag explicitly"
    );
  }
  if (taskNetworkAllowlist) {
    throw new AssayError(
      "sandbox_unavailable",
      "sandbox_unavailable: R1 cannot enforce a task network allowlist and never degrades it to unrestricted host networking; no run started; use network: none or wait for the R2 sandbox"
    );
  }
  runtime.signal.throwIfAborted();

  if (invocation.dryRun === true) {
    io.stdout(`${canonicalJson(dryRunPlan(
      invocation,
      suite,
      adapter,
      configuredRunsPerTask,
      invocationRootSeed,
      taskPolicies,
      resolvedConfig.configHash,
      resolvedConfig.config.pricingCatalogVersion
    ))}\n`);
    return 0;
  }

  let adapterCommand: AdapterCommand;
  try {
    adapterCommand = runtime.adapterCommandFor(adapter);
  } catch (cause) {
    if (cause instanceof AssayError) throw cause;
    throw new AssayError(
      "adapter_unavailable",
      `adapter_unavailable: ${adapter} could not be resolved; no run record or provider activity occurred; install or repair the adapter`,
      { cause }
    );
  }

  const knownHashes = new Set<string>([
    suite.source.suiteContentHash,
    resolvedConfig.configHash,
    ...suite.tasks.map((task) => task.source.contentHash)
  ]);
  const replayingTaskRunIds = new ReplayingIdSource(runtime.taskRunIdSource);
  const plans: PlannedTaskRun[] = [];
  for (const policy of taskPolicies) {
    for (let repetition = 0; repetition < policy.repetitions; repetition += 1) {
      plans.push({
        task: policy.task,
        repetition,
        rootSeed: policy.rootSeed,
        seedStrategy: policy.seedStrategy,
        seed: policy.effectiveSeeds[repetition]!,
        taskRunId: replayingTaskRunIds.reserve()
      });
    }
  }

  const store = await openRunStore({
    projectRoot: runtime.projectRoot,
    storePath: resolvedConfig.config.storePath,
    clock: runtime.clock,
    processId: runtime.processId,
    runIdSource: runtime.runIdSource,
    taskRunIdSource: replayingTaskRunIds,
    eventIdSource: runtime.eventIdSource
  });
  const sequence = { value: 0 };
  try {
    const runId = await store.appendRun({
      createdAtUtc: runtime.clock.wallTime(),
      suiteHash: createContentHash(suite.source.suiteContentHash),
      variant: createVariantName(invocation.variant),
      adapterId: adapter,
      adapterVersion: "1.0.0",
      modelId: model,
      seed: invocationRootSeed,
      harnessVersion: HARNESS_VERSION,
      runsPerTask: configuredRunsPerTask,
      status: "in_progress",
      isolation: "unsafe_host"
    });
    await appendEventBatch(store, runId, [event("RunPlanned", runId, runtime.clock.wallTime(), {
      suiteContentHash: suite.source.suiteContentHash,
      configHash: resolvedConfig.configHash,
      taskPolicies: taskPolicies.map((policy) => ({
        taskId: policy.task.id,
        taskContentHash: policy.task.source.contentHash,
        repetitions: policy.repetitions,
        rootSeed: policy.rootSeed,
        seedStrategy: policy.seedStrategy,
        effectiveSeeds: policy.effectiveSeeds
      })),
      tasks: plans.map((plan) => ({
        taskId: plan.task.id,
        taskRunId: plan.taskRunId,
        taskContentHash: plan.task.source.contentHash,
        repetition: plan.repetition,
        rootSeed: plan.rootSeed,
        seedStrategy: plan.seedStrategy,
        seed: plan.seed
      }))
    })], sequence);

    io.stderr(UNSAFE_BANNER);
    const startedAtUtc = new Map<TaskRunId, string>();
    const results = await runTaskRunsSequentially(plans, async (plan, signal): Promise<TaskExecutionResult> => {
      startedAtUtc.set(plan.taskRunId, runtime.clock.wallTime());
      return executeTaskRun(plan, {
        materialize: async () => materializeFixture(plan.task.fixture),
        startAgent: async () => adapterCommand,
        collect: async (_currentPlan, workspace, command) => {
          const result = await superviseAdapter({
            command,
            spec: {
              taskId: createTaskId(plan.task.id),
              taskRunId: plan.taskRunId,
              prompt: plan.task.prompt,
              workspacePath: workspace.workspaceRoot,
              seed: plan.seed,
              env: plan.task.environment,
              limits: { wallClockMs: plan.task.timeoutMs },
              budgetsAdvisory: {}
            },
            cwd: workspace.workspaceRoot,
            env: {},
            redactor: adapterRedactor(knownHashes),
            signal
          });
          const redacted = redactAdapterEventBatch(result.events, knownHashes);
          return {
            result: { ...result, events: redacted.events },
            events: redacted.events,
            eventManifests: redacted.manifests
          };
        },
        seal: async (_currentPlan, workspace, collection) => ({
          workspace,
          collection,
          trajectoryBytes: trajectoryBytes(plan, collection, knownHashes),
          snapshotBytes: await snapshotWorkspace(workspace.workspaceRoot, knownHashes),
          assertionResults: []
        }),
        assert: async (_currentPlan, evidence, assertionSignal) => {
          const category = evidence.collection.result.errorCategory;
          if (category !== null) throw categoryError(category);
          return {
            hasJudgeAssertions: false,
            outcome: await evaluateAssertions(plan, evidence, runtime, knownHashes, assertionSignal)
          };
        },
        cleanup: async (_currentPlan, workspace) => destroyWorkspace(workspace),
        persist: async (_currentPlan, lifecycle, evidence) => {
          const trajectoryBlob = evidence === undefined ? null : await store.putBlob(evidence.trajectoryBytes);
          const workspaceSnapshot = evidence === undefined ? null : await store.putBlob(evidence.snapshotBytes);
          const taskRunId = await store.appendTaskRun(runId, {
            taskId: createTaskId(plan.task.id),
            taskContentHash: createContentHash(plan.task.source.contentHash),
            attempt: plan.repetition,
            state: persistedState(lifecycle),
            outcome: lifecycle.outcome,
            errorCategory: lifecycle.errorCategory,
            trajectoryBlob,
            workspaceSnapshot,
            assertionResults: evidence?.assertionResults ?? [],
            usage: evidence === undefined ? null : usageFrom(evidence.collection.events),
            startedAtUtc: startedAtUtc.get(plan.taskRunId) ?? runtime.clock.wallTime(),
            endedAtUtc: runtime.clock.wallTime()
          });
          if (taskRunId !== plan.taskRunId) {
            throw new AssayError(
              "internal_invariant",
              `internal_invariant: reserved task-run id ${plan.taskRunId} was persisted as ${taskRunId}; repair the composition identifier source`
            );
          }
          await appendEventBatch(
            store,
            runId,
            assayEventsForTask(runId, plan, evidence, lifecycle, "unsafe_host", runtime.clock.wallTime()),
            sequence
          );
        }
      }, signal);
    }, runtime.signal);

    const codes: ExitCode[] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;
    let firstCategory: AssayErrorCategory | null = null;
    for (const result of results) {
      if (result.lifecycle.state === "cancelled") {
        codes.push(6);
        firstCategory ??= "cancelled";
        errors += 1;
      } else if (result.lifecycle.state === "completed" && result.lifecycle.outcome === "pass") {
        passed += 1;
        codes.push(0);
      } else if (result.lifecycle.state === "completed" && result.lifecycle.outcome === "fail") {
        failed += 1;
        codes.push(1);
      } else {
        errors += 1;
        const category = result.lifecycle.errorCategory ?? "internal_invariant";
        firstCategory ??= category;
        codes.push(exitCodeForCategory(category));
      }
    }
    const exitCode = aggregateExitCode(codes);
    const finalType = exitCode === 6 ? "RunCancelled" : exitCode === 5 ? "RunFailed" : "SuiteCompleted";
    await appendEventBatch(store, runId, [event(finalType, runId, runtime.clock.wallTime(), {
      passed,
      failed,
      errors,
      exitCode,
      ...(firstCategory === null ? {} : { category: firstCategory })
    })], sequence);
    await store.settleRun(
      runId,
      exitCode === 6 ? "cancelled" : exitCode === 5 ? "failed" : "completed"
    );
    io.stdout(`Run ${runId}: ${passed} passed, ${failed} failed, ${errors} errors (isolation: unsafe_host)\n`);
    if (exitCode === 6) throw categoryError("cancelled");
    if (exitCode === 5) throw categoryError(firstCategory ?? "internal_invariant");
    return exitCode;
  } finally {
    await store.close();
  }
}
