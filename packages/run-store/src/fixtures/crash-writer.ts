import {
  createBlobHash,
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  createVariantName,
  type AssayEvent,
  type Clock,
  type IdSource,
  type NewRunRecord
} from "@assay/contracts";

import {
  openRunStore,
  sha256Blob,
  type NewTaskRunRecord,
  type StoreFaultMarker
} from "../index.js";

const markerValues = new Set<StoreFaultMarker>([
  "before_blob_rename",
  "after_blob_rename",
  "before_run_commit",
  "after_run_commit",
  "before_task_run_commit",
  "after_task_run_commit",
  "before_event_commit",
  "after_event_commit"
]);
const [projectRoot, runIdValue, taskRunIdValue, markerValue] = process.argv.slice(2);

if (
  projectRoot === undefined ||
  runIdValue === undefined ||
  taskRunIdValue === undefined ||
  markerValue === undefined ||
  !markerValues.has(markerValue as StoreFaultMarker)
) {
  throw new Error("crash-writer requires project root, run id, task-run id, and fault marker");
}

const runId = createRunId(runIdValue);
const taskRunId = createTaskRunId(taskRunIdValue);
const marker = markerValue as StoreFaultMarker;
const wallTime = "2026-08-30T12:34:56.789Z";
const clock: Clock = {
  wallTime: () => wallTime,
  monotonicMilliseconds: () => 1_000
};
const oneValue = <T extends string>(value: T): IdSource<T> => ({ next: () => value });
const trajectoryBytes = new TextEncoder().encode("crash injection trajectory");
const trajectoryHash = createBlobHash(sha256Blob(trajectoryBytes));
const runRecord: NewRunRecord = {
  createdAtUtc: wallTime,
  suitePath: "suites/crash.suite.yaml",
  suiteContentHash: createContentHash("c".repeat(64)),
  tasks: [{
    taskId: createTaskId("task-crash"),
    taskContentHash: createContentHash("d".repeat(64)),
    repetitions: 1,
    rootSeed: 23,
    seedStrategy: "derived",
    effectiveSeeds: ["crash-seed"]
  }],
  variant: {
    name: createVariantName("baseline"),
    adapter: "simulated",
    model: "synthetic/scripted-v1",
    promptVersion: null,
    toolsetVersion: null,
    agentVersion: null
  },
  configHash: createContentHash("e".repeat(64)),
  adapterId: "adapter-simulated",
  adapterVersion: "1.0.0",
  contractVersion: "assay-adapter/1",
  adapterTier: "full",
  providerReportedModel: {
    provider: "synthetic",
    model: "scripted-v1",
    family: "synthetic"
  },
  rootSeed: 23,
  harnessVersion: "0.0.0",
  pricingCatalogVersion: "catalog-v1",
  runsPerTask: 1,
  status: "completed",
  isolationLabel: "isolated"
};
const taskRun: NewTaskRunRecord = {
  taskId: createTaskId("task-crash"),
  taskContentHash: createContentHash("d".repeat(64)),
  repetition: 0,
  attempt: 0,
  seed: "crash-seed",
  state: "completed",
  outcome: "pass",
  errorCategory: null,
  trajectoryBlob: trajectoryHash,
  workspaceSnapshot: null,
  assertionResults: [],
  usage: null,
  startedAtUtc: wallTime,
  endedAtUtc: wallTime
};
const completedEvent: AssayEvent = {
  schema_version: 1,
  type: "TaskRunCompleted",
  run_id: runId,
  task_run_id: taskRunId,
  timestamp: wallTime,
  payload: { outcome: "pass" }
};

const store = await openRunStore({
  projectRoot,
  clock,
  processId: process.pid,
  runIdSource: oneValue(runId),
  taskRunIdSource: oneValue(taskRunId),
  eventIdSource: oneValue("event-crash"),
  lockPolicy: { maxAttempts: 3, retryDelayMs: 2 },
  faultInjector: (current) => {
    if (current === marker) {
      process.kill(process.pid, "SIGKILL");
    }
  }
});

try {
  if (marker === "before_run_commit" || marker === "after_run_commit") {
    await store.appendRun(runRecord);
  } else {
    await store.putBlob(trajectoryBytes);
    await store.appendTaskRunWithEvents(
      runId,
      taskRun,
      [{ sequence: 0, event: completedEvent }]
    );
  }
} finally {
  await store.close();
}
