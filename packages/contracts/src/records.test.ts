import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import {
  createContentHash,
  createRunId,
  createTaskId,
  createTaskRunId,
  createVariantName
} from "./ids.js";
import type { RunRecord, TaskRunRecord } from "./records.js";

describe("R1 run identity records", () => {
  it("RUN-010 exposes the complete FR-RUN-007 binding on the canonical run record", () => {
    const taskContentHash = createContentHash("b".repeat(64));
    const record = {
      runId: createRunId("01890f4e-7b72-7000-8000-000000000001"),
      createdAtUtc: "2026-08-30T12:34:56.789Z",
      suitePath: "suites/core.suite.yaml",
      suiteContentHash: createContentHash("a".repeat(64)),
      tasks: [{
        taskId: createTaskId("task-a"),
        taskContentHash,
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
    } as const satisfies RunRecord;

    expect(JSON.parse(canonicalJson(record))).toEqual(record);
    expect(record.tasks[0]?.effectiveSeeds).toHaveLength(record.tasks[0]?.repetitions ?? 0);
  });

  it("binds task repetition and effective seed independently from retry attempt", () => {
    const record = {
      taskRunId: createTaskRunId("01890f4e-7b72-7000-8000-000000000101"),
      runId: createRunId("01890f4e-7b72-7000-8000-000000000001"),
      taskId: createTaskId("task-a"),
      taskContentHash: createContentHash("b".repeat(64)),
      repetition: 1,
      attempt: 0,
      seed: "2222222222222222",
      state: "completed",
      outcome: "pass",
      errorCategory: null,
      trajectoryBlob: null,
      workspaceSnapshot: null,
      assertionResults: [],
      usage: null,
      startedAtUtc: "2026-08-30T12:34:56.789Z",
      endedAtUtc: "2026-08-30T12:34:56.789Z"
    } as const satisfies TaskRunRecord;

    expect(record).toMatchObject({ repetition: 1, attempt: 0, seed: "2222222222222222" });
  });
});
