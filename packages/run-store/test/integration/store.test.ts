import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  createBlobHash,
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  createVariantName,
  type AssayEvent,
  type Clock,
  type IdSource,
  type RunId,
  type TaskRunId
} from "@assay/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openRunStore,
  type NewRunRecord,
  type NewTaskRunRecord,
  type RunStoreOptions
} from "../../src/index.js";

const createdRoots: string[] = [];
const wallTime = "2026-08-30T12:34:56.789Z";
const fixedClock: Clock = {
  wallTime: () => wallTime,
  monotonicMilliseconds: () => 1_000
};

const RUN_IDS = [
  createRunId("01890f4e-7b72-7000-8000-000000000001"),
  createRunId("01890f4e-7b72-7000-8000-000000000002"),
  createRunId("01890f4e-7b72-7000-8000-000000000003")
] as const;
const TASK_RUN_IDS = [
  createTaskRunId("01890f4e-7b72-7000-8000-000000000101"),
  createTaskRunId("01890f4e-7b72-7000-8000-000000000102"),
  createTaskRunId("01890f4e-7b72-7000-8000-000000000103")
] as const;

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    })
  );
});

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "assay-run-store-"));
  createdRoots.push(root);
  return root;
}

function sequenceSource<T extends string>(values: readonly T[]): IdSource<T> {
  let index = 0;
  return {
    next: () => {
      const value = values[index];
      if (value === undefined) {
        throw new Error("test identifier source exhausted");
      }
      index += 1;
      return value;
    }
  };
}

function storeOptions(
  projectRoot: string,
  overrides: Partial<RunStoreOptions> = {}
): RunStoreOptions {
  return {
    projectRoot,
    clock: fixedClock,
    processId: process.pid,
    runIdSource: sequenceSource(RUN_IDS),
    taskRunIdSource: sequenceSource(TASK_RUN_IDS),
    eventIdSource: sequenceSource(["event-0001", "event-0002", "event-0003"]),
    lockPolicy: { maxAttempts: 2, retryDelayMs: 2 },
    ...overrides
  };
}

function newRun(overrides: Partial<NewRunRecord> = {}): NewRunRecord {
  return {
    createdAtUtc: wallTime,
    suitePath: "suites/core.suite.yaml",
    suiteContentHash: createContentHash("a".repeat(64)),
    tasks: [{
      taskId: createTaskId("task-a"),
      taskContentHash: createContentHash("b".repeat(64)),
      repetitions: 10,
      rootSeed: 17,
      seedStrategy: "derived",
      effectiveSeeds: Array.from({ length: 10 }, (_, index) => `seed-${index}`)
    }],
    variant: {
      name: createVariantName("baseline"),
      adapter: "simulated",
      model: "synthetic/scripted-v1",
      promptVersion: null,
      toolsetVersion: null,
      agentVersion: null
    },
    configHash: createContentHash("c".repeat(64)),
    adapterId: "adapter-simulated",
    adapterVersion: "1.0.0",
    contractVersion: "assay-adapter/1",
    adapterTier: "full",
    providerReportedModel: {
      provider: "synthetic",
      model: "scripted-v1",
      family: "synthetic"
    },
    rootSeed: 17,
    harnessVersion: "0.0.0",
    pricingCatalogVersion: "catalog-v1",
    runsPerTask: 10,
    status: "completed",
    isolationLabel: "isolated",
    ...overrides
  };
}

function newTaskRun(
  trajectoryBlob: ReturnType<typeof createBlobHash> | null = null,
  overrides: Partial<NewTaskRunRecord> = {}
): NewTaskRunRecord {
  return {
    taskId: createTaskId("task-a"),
    taskContentHash: createContentHash("b".repeat(64)),
    repetition: 0,
    attempt: 0,
    seed: "seed-0",
    state: "completed",
    outcome: "pass",
    errorCategory: null,
    trajectoryBlob,
    workspaceSnapshot: null,
    assertionResults: [],
    usage: null,
    startedAtUtc: wallTime,
    endedAtUtc: wallTime,
    ...overrides
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

function objectPath(projectRoot: string, hash: string): string {
  return join(projectRoot, ".assay", "objects", hash.slice(0, 2), hash);
}

function rawDatabase(projectRoot: string): DatabaseSync {
  return new DatabaseSync(join(projectRoot, ".assay", "assay.db"));
}

describe("R1.12 store core", () => {
  it("STO-001 initializes the exact minimal schema in WAL mode with private permissions", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));

    expect(await store.diagnostics()).toMatchObject({
      schemaVersion: 1,
      journalMode: "wal",
      quickCheck: "ok"
    });

    const database = rawDatabase(projectRoot);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { readonly name: string }).name);
    const schemaRows = database.prepare("SELECT version FROM schema_meta").all();
    database.close();

    expect(tables).toEqual(
      expect.arrayContaining(["events", "quarantine_records", "runs", "schema_meta", "task_runs"])
    );
    expect(schemaRows).toEqual([{ version: 1 }]);
    expect((await stat(join(projectRoot, ".assay"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(projectRoot, ".assay", "objects"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(projectRoot, ".assay", "assay.db"))).mode & 0o777).toBe(0o600);

    await store.close();
  });

  it("uses the configured store path relative to the project root", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot, {
      storePath: "state/private-store"
    }));

    expect(await store.diagnostics()).toMatchObject({
      databasePath: join(projectRoot, "state", "private-store", "assay.db"),
      objectsPath: join(projectRoot, "state", "private-store", "objects")
    });
    await expect(stat(join(projectRoot, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(projectRoot, "state", "private-store"))).mode & 0o777).toBe(0o700);

    await store.close();
  });

  it("writes one stable private store-identity config marker", async () => {
    const projectRoot = await temporaryProject();
    let store = await openRunStore(storeOptions(projectRoot));
    const markerPath = join(projectRoot, ".assay", "config");
    const firstBytes = await readFile(markerPath, "utf8");
    const marker = JSON.parse(firstBytes) as Record<string, unknown>;

    expect(marker).toEqual({
      createdByVersion: "0.0.0",
      schemaVersion: 1,
      storeId: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(firstBytes).toBe(canonicalJson(marker));
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);

    await store.close();
    store = await openRunStore(storeOptions(projectRoot));
    expect(await readFile(markerPath, "utf8")).toBe(firstBytes);
    await store.close();
  });

  it("rejects absolute, traversal, and symlinked store paths before creating outside state", async () => {
    const projectRoot = await temporaryProject();
    const outsideRoot = await temporaryProject();
    const outsideStore = join(outsideRoot, "assay-state");

    await expect(openRunStore(storeOptions(projectRoot, {
      storePath: outsideStore
    }))).rejects.toMatchObject({ category: "invalid_configuration" });
    await expect(openRunStore(storeOptions(projectRoot, {
      storePath: join("..", basename(outsideRoot), "assay-state")
    }))).rejects.toMatchObject({ category: "invalid_configuration" });

    await symlink(outsideRoot, join(projectRoot, "linked-parent"), "dir");
    await expect(openRunStore(storeOptions(projectRoot, {
      storePath: "linked-parent/assay-state"
    }))).rejects.toMatchObject({ category: "invalid_configuration" });
    await expect(stat(outsideStore)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("STO-001 atomically appends canonical run, task-run, and event records", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const runInput = newRun();
    const runId = await store.appendRun(runInput);
    const taskInput = newTaskRun();
    const taskRunId = await store.appendTaskRun(runId, taskInput);
    const event: AssayEvent = {
      schema_version: 1,
      type: "RunPlanned",
      run_id: runId,
      timestamp: wallTime,
      payload: { suite_hash: runInput.suiteContentHash }
    };

    const eventId = await store.appendEvent(runId, 0, event);

    expect(eventId).toBe("event-0001");
    expect(await store.getRun(runId)).toEqual({ runId, ...runInput });
    expect(await store.getTaskRun(taskRunId)).toEqual({ taskRunId, runId, ...taskInput });
    expect(await store.listEvents(runId)).toEqual([{ eventId, sequence: 0, event }]);
    expect(await collect(store.listRuns({}))).toEqual([{ runId, ...runInput }]);
    expect(await collect(store.listTaskRuns(runId))).toEqual([
      { taskRunId, runId, ...taskInput }
    ]);

    const database = rawDatabase(projectRoot);
    const raw = database
      .prepare("SELECT record_json, record_hash FROM runs WHERE run_id = ?")
      .get(runId) as { readonly record_json: string; readonly record_hash: string };
    database.close();
    expect(raw.record_json).toBe(canonicalJson({ runId, ...runInput }));
    expect(raw.record_hash).toMatch(/^[0-9a-f]{64}$/u);

    await store.close();
  });

  it("RUN-010 round-trips the complete identity binding in the canonical run row", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const input = {
      createdAtUtc: wallTime,
      suitePath: "suites/core.suite.yaml",
      suiteContentHash: createContentHash("a".repeat(64)),
      tasks: [{
        taskId: createTaskId("task-a"),
        taskContentHash: createContentHash("b".repeat(64)),
        repetitions: 2,
        rootSeed: 42,
        seedStrategy: "derived",
        effectiveSeeds: ["1111111111111111", "2222222222222222"]
      }],
      variant: {
        name: createVariantName("baseline"),
        adapter: "simulated",
        model: "synthetic/scripted-v1",
        promptVersion: "prompt-v1",
        toolsetVersion: "simulated/1",
        agentVersion: "adapter-simulated@1.0.0"
      },
      configHash: createContentHash("c".repeat(64)),
      adapterId: "adapter-simulated",
      adapterVersion: "1.0.0",
      contractVersion: "assay-adapter/1",
      adapterTier: "full",
      providerReportedModel: {
        provider: "synthetic",
        model: "scripted-v1",
        family: "synthetic"
      },
      rootSeed: 42,
      harnessVersion: "0.0.0",
      pricingCatalogVersion: "catalog-v1",
      runsPerTask: 2,
      status: "completed",
      isolationLabel: "unsafe_host"
    } as const satisfies NewRunRecord;

    const runId = await store.appendRun(input);

    expect(await store.getRun(runId)).toEqual({ runId, ...input });
    const database = rawDatabase(projectRoot);
    const stored = database.prepare("SELECT record_json FROM runs WHERE run_id = ?")
      .get(runId) as { readonly record_json: string };
    database.close();
    expect(stored.record_json).toBe(canonicalJson({ runId, ...input }));
    await store.close();
  });

  it("STO-001 commits a task-run row and its associated events as one batch", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const runId = await store.appendRun(newRun());
    const taskInput = newTaskRun();
    const event: AssayEvent = {
      schema_version: 1,
      type: "TaskRunCompleted",
      run_id: runId,
      task_run_id: TASK_RUN_IDS[0],
      timestamp: wallTime,
      payload: { outcome: "pass" }
    };

    const taskRunId = await store.appendTaskRunWithEvents(
      runId,
      taskInput,
      [{ sequence: 0, event }]
    );

    expect(taskRunId).toBe(TASK_RUN_IDS[0]);
    expect(await store.getTaskRun(taskRunId)).toEqual({ taskRunId, runId, ...taskInput });
    expect(await store.listEvents(runId)).toEqual([
      { eventId: "event-0001", sequence: 0, event }
    ]);
    await store.close();
  });

  it("STO-001 rolls back the task-run row when an associated event faults", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot, {
      faultInjector: (marker) => {
        if (marker === "before_event_commit") {
          throw new Error("injected event failure");
        }
      }
    }));
    const runId = await store.appendRun(newRun());
    const event: AssayEvent = {
      schema_version: 1,
      type: "TaskRunCompleted",
      run_id: runId,
      task_run_id: TASK_RUN_IDS[0],
      timestamp: wallTime,
      payload: { outcome: "pass" }
    };

    await expect(store.appendTaskRunWithEvents(
      runId,
      newTaskRun(),
      [{ sequence: 0, event }]
    )).rejects.toMatchObject({ category: "internal_invariant" });

    expect(await collect(store.listTaskRuns(runId))).toEqual([]);
    expect(await store.listEvents(runId)).toEqual([]);
    await store.close();
  });

  it("FR-RUN-009 appends reruns without changing prior evidence", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const input = newRun();
    const firstId = await store.appendRun(input);
    const firstBytes = canonicalJson(await store.getRun(firstId));
    const secondId = await store.appendRun(input);

    expect(secondId).not.toBe(firstId);
    expect(canonicalJson(await store.getRun(firstId))).toBe(firstBytes);
    expect(await collect(store.listRuns({}))).toHaveLength(2);

    await store.close();
  });

  it("settles one in-progress run exactly once without mutating a rerun", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const firstId = await store.appendRun(newRun({ status: "in_progress" }));
    const secondId = await store.appendRun(newRun({ status: "in_progress" }));
    const secondBefore = canonicalJson(await store.getRun(secondId));

    await store.settleRun(firstId, "completed");

    expect(await store.getRun(firstId)).toMatchObject({ status: "completed" });
    expect(canonicalJson(await store.getRun(secondId))).toBe(secondBefore);
    await expect(store.settleRun(firstId, "failed")).rejects.toMatchObject({
      category: "internal_invariant"
    });
    expect(await store.getRun(firstId)).toMatchObject({ status: "completed" });
    expect(await store.getRun(secondId)).toMatchObject({ status: "in_progress" });

    await store.close();
  });

  it("makes retried task persistence idempotent on the immutable natural key", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const runId = await store.appendRun(newRun());
    const input = newTaskRun();

    const firstId = await store.appendTaskRun(runId, input);
    const replayedId = await store.appendTaskRun(runId, input);

    expect(replayedId).toBe(firstId);
    expect(await collect(store.listTaskRuns(runId))).toHaveLength(1);
    await expect(
      store.appendTaskRun(runId, newTaskRun(null, { outcome: "fail" }))
    ).rejects.toMatchObject({ category: "internal_invariant" });
    expect((await store.getTaskRun(firstId)).outcome).toBe("pass");

    await store.close();
  });

  it("STO-002 stores immutable fsynced blobs by sha256 and treats identical puts as success", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const bytes = new TextEncoder().encode("canonical trajectory bytes");

    const first = await store.putBlob(bytes);
    const second = await store.putBlob(bytes);

    expect(second).toBe(first);
    expect(await store.getBlob(first)).toEqual(bytes);
    expect((await stat(objectPath(projectRoot, first))).isFile()).toBe(true);
    expect((await stat(objectPath(projectRoot, first))).mode & 0o777).toBe(0o600);

    await store.close();
  });

  it("refuses a task row until every referenced blob is durable and hash-valid", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const runId = await store.appendRun(newRun());
    const missing = createBlobHash("e".repeat(64));

    await expect(store.appendTaskRun(runId, newTaskRun(missing))).rejects.toMatchObject({
      category: "storage_corrupt"
    });
    expect(await collect(store.listTaskRuns(runId))).toEqual([]);
    expect((await store.verifyIntegrity()).danglingBlobReferences).toEqual([]);

    await store.close();
  });

  it("STO-003 quarantines a record whose canonical-json hash no longer verifies", async () => {
    const projectRoot = await temporaryProject();
    let store = await openRunStore(storeOptions(projectRoot));
    const runId = await store.appendRun(newRun());
    await store.close();

    const database = rawDatabase(projectRoot);
    const current = database
      .prepare("SELECT record_json FROM runs WHERE run_id = ?")
      .get(runId) as { readonly record_json: string };
    database
      .prepare("UPDATE runs SET record_json = ? WHERE run_id = ?")
      .run(current.record_json.replace('"baseline"', '"tampered"'), runId);
    database.close();

    store = await openRunStore(storeOptions(projectRoot));
    await expect(store.getRun(runId)).rejects.toMatchObject({ category: "storage_corrupt" });
    const quarantined = await store.listQuarantined();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      entityType: "run",
      entityId: runId,
      category: "storage_corrupt",
      detectedAtUtc: wallTime
    });
    expect(quarantined[0]?.originalRecordJson).toContain('"tampered"');
    await expect(store.getRun(runId)).rejects.toMatchObject({ category: "storage_corrupt" });

    await store.close();
  });

  it("STO-003 quarantines a tampered blob and every task-run that referenced it", async () => {
    const projectRoot = await temporaryProject();
    let store = await openRunStore(storeOptions(projectRoot));
    const bytes = new TextEncoder().encode("untampered trajectory");
    const blobHash = await store.putBlob(bytes);
    const runId = await store.appendRun(newRun());
    const taskRunId = await store.appendTaskRun(runId, newTaskRun(blobHash));
    await store.close();

    await writeFile(objectPath(projectRoot, blobHash), "tampered trajectory", { mode: 0o600 });

    store = await openRunStore(storeOptions(projectRoot));
    await expect(store.getBlob(blobHash)).rejects.toMatchObject({ category: "storage_corrupt" });
    const quarantined = await store.listQuarantined();
    expect(quarantined.map(({ entityType }) => entityType).sort()).toEqual(["blob", "task_run"]);
    const blobEvidence = quarantined.find(({ entityType }) => entityType === "blob");
    expect(blobEvidence?.quarantinedBlobPath).toBeDefined();
    expect((await stat(blobEvidence?.quarantinedBlobPath as string)).isFile()).toBe(true);
    await expect(store.getTaskRun(taskRunId)).rejects.toMatchObject({
      category: "storage_corrupt"
    });

    await store.close();
  });

  it("refuses older and newer schema versions without implicitly migrating", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    await store.close();

    const database = rawDatabase(projectRoot);
    database.prepare("UPDATE schema_meta SET version = 0").run();
    database.close();

    await expect(openRunStore(storeOptions(projectRoot))).rejects.toMatchObject({
      category: "storage_migration_required",
      message: expect.stringContaining("assay db migrate")
    });

    const newer = rawDatabase(projectRoot);
    expect(newer.prepare("SELECT version FROM schema_meta").get()).toEqual({ version: 0 });
    newer.prepare("UPDATE schema_meta SET version = 2").run();
    newer.close();

    await expect(openRunStore(storeOptions(projectRoot))).rejects.toMatchObject({
      category: "storage_migration_required",
      message: expect.stringContaining("upgrade the Assay binary")
    });

    const unchanged = rawDatabase(projectRoot);
    expect(unchanged.prepare("SELECT version FROM schema_meta").get()).toEqual({ version: 2 });
    unchanged.close();
  });

  it("bounds writer-lock acquisition and identifies the owning process", async () => {
    const projectRoot = await temporaryProject();
    const first = await openRunStore(storeOptions(projectRoot));
    const started = performance.now();

    await expect(openRunStore(storeOptions(projectRoot))).rejects.toMatchObject({
      category: "storage_locked",
      message: expect.stringContaining(String(process.pid))
    });
    expect(performance.now() - started).toBeLessThan(500);

    await first.close();
    const reopened = await openRunStore(storeOptions(projectRoot));
    await reopened.close();
    await reopened.close();
  });

  it("quarantines an unreadable database file instead of repairing or replacing it", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    await store.close();
    await writeFile(join(projectRoot, ".assay", "assay.db"), "not a sqlite database", {
      mode: 0o600
    });

    await expect(openRunStore(storeOptions(projectRoot))).rejects.toMatchObject({
      category: "storage_corrupt"
    });

    const names = await readdir(join(projectRoot, ".assay"));
    expect(names.some((name) => name.startsWith("assay.db.quarantined."))).toBe(true);
    expect(names).not.toContain("assay.db");
  });

  it("rejects a pre-existing group-writable store directory before opening sensitive data", async () => {
    const projectRoot = await temporaryProject();
    const bootstrap = await openRunStore(storeOptions(projectRoot));
    await bootstrap.close();
    await chmod(join(projectRoot, ".assay"), 0o770);

    await expect(openRunStore(storeOptions(projectRoot))).rejects.toMatchObject({
      category: "storage_corrupt",
      message: expect.stringContaining("assay doctor")
    });
  });

  it("classifies a duplicate durable event sequence as an invariant violation", async () => {
    const projectRoot = await temporaryProject();
    const store = await openRunStore(storeOptions(projectRoot));
    const runId = await store.appendRun(newRun());
    const event: AssayEvent = {
      schema_version: 1,
      type: "RunPlanned",
      run_id: runId,
      timestamp: wallTime,
      payload: {}
    };
    await store.appendEvent(runId, 0, event);

    await expect(store.appendEvent(runId, 0, event)).rejects.toMatchObject({
      category: "internal_invariant"
    });

    await store.close();
  });
});
