import {
  createBlobHash,
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  type Clock,
  type IdSource
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
  "before_task_run_commit",
  "after_task_run_commit"
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
const taskRun: NewTaskRunRecord = {
  taskId: createTaskId("task-crash"),
  taskContentHash: createContentHash("d".repeat(64)),
  attempt: 0,
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

const store = await openRunStore({
  projectRoot,
  clock,
  processId: process.pid,
  runIdSource: oneValue(createRunId("01890f4e-7b72-7000-8000-000000000299")),
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
  await store.putBlob(trajectoryBytes);
  await store.appendTaskRun(runId, taskRun);
} finally {
  await store.close();
}
