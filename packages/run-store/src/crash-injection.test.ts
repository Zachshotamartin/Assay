import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  createVariantName,
  type Clock,
  type IdSource
} from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openRunStore,
  sha256Blob,
  type NewRunRecord,
  type RunStoreOptions,
  type StoreFaultMarker
} from "./index.js";

const roots: string[] = [];
const runId = createRunId("01890f4e-7b72-7000-8000-000000000201");
const taskRunId = createTaskRunId("01890f4e-7b72-7000-8000-000000000202");
const wallTime = "2026-08-30T12:34:56.789Z";
const clock: Clock = {
  wallTime: () => wallTime,
  monotonicMilliseconds: () => 1_000
};
const trajectoryBytes = new TextEncoder().encode("crash injection trajectory");
const trajectoryHash = sha256Blob(trajectoryBytes);
const childPath = fileURLToPath(new URL("./fixtures/crash-writer.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function oneValue<T extends string>(value: T): IdSource<T> {
  return { next: () => value };
}

function options(projectRoot: string): RunStoreOptions {
  return {
    projectRoot,
    clock,
    processId: process.pid,
    runIdSource: oneValue(runId),
    taskRunIdSource: oneValue(taskRunId),
    eventIdSource: oneValue("event-crash"),
    lockPolicy: { maxAttempts: 3, retryDelayMs: 2 }
  };
}

function runRecord(): NewRunRecord {
  return {
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
}

async function initializeProject(withRun: boolean): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "assay-store-crash-"));
  roots.push(projectRoot);
  const store = await openRunStore(options(projectRoot));
  if (withRun) {
    expect(await store.appendRun(runRecord())).toBe(runId);
  }
  await store.close();
  return projectRoot;
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function crashAt(projectRoot: string, marker: StoreFaultMarker): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childPath, projectRoot, runId, taskRunId, marker],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, timedOut });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function objectPath(projectRoot: string): string {
  return join(projectRoot, ".assay", "objects", trajectoryHash.slice(0, 2), trajectoryHash);
}

describe("R1.12 store crash injection", () => {
  it.each([
    ["before_run_commit", false, false, false, false],
    ["after_run_commit", true, false, false, false],
    ["before_blob_rename", true, false, false, false],
    ["after_blob_rename", true, true, false, false],
    ["before_task_run_commit", true, true, false, false],
    ["before_event_commit", true, true, false, false],
    ["after_task_run_commit", true, true, true, true],
    ["after_event_commit", true, true, true, true]
  ] as const)(
    "STO-001/STO-002 kill at %s leaves only durable complete state",
    async (marker, runExpected, blobExpected, rowExpected, eventExpected) => {
      const projectRoot = await initializeProject(
        marker !== "before_run_commit" && marker !== "after_run_commit"
      );
      const child = await crashAt(projectRoot, marker);

      expect(child.timedOut, child.stderr).toBe(false);
      expect(child.code, child.stderr).toBeNull();
      expect(child.signal, child.stderr).toBe("SIGKILL");

      const store = await openRunStore(options(projectRoot));
      const runs = [];
      for await (const record of store.listRuns({})) {
        runs.push(record);
      }
      expect(runs).toEqual(runExpected ? [{ runId, ...runRecord() }] : []);
      expect(await exists(objectPath(projectRoot))).toBe(blobExpected);
      const taskRuns = [];
      for await (const record of store.listTaskRuns(runId)) {
        taskRuns.push(record);
      }
      expect(taskRuns.map(({ taskRunId: id }) => id)).toEqual(rowExpected ? [taskRunId] : []);
      expect((await store.listEvents(runId)).map(({ eventId }) => eventId)).toEqual(
        eventExpected ? ["event-crash"] : []
      );
      expect((await store.verifyIntegrity()).danglingBlobReferences).toEqual([]);
      expect(await store.listQuarantined()).toEqual([]);
      await store.close();
    }
  );
});
