import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  BlobHash,
  ContentHash,
  RunId,
  SandboxId,
  TaskId,
  TaskRunId,
  TrajectoryMetricId,
  VariantName
} from "./ids.js";
import {
  createBlobHash,
  createContentHash,
  createRunId,
  createSandboxId,
  createTaskId,
  createTaskRunId,
  createTrajectoryMetricId,
  createVariantName
} from "./ids.js";

const UUID_V7 = "01890f70-6c50-7cc8-b2cb-566b786e0000";
const SHA256 = "9f2c9c7b1f9d6a48a6e6af94df9b7c2e0c27de7dc5ae09176d6bf5c2d158ed44";

describe("branded identifier factories", () => {
  it("constructs every fixed identifier type from a canonical value", () => {
    expect(createTaskId("fix-null-deref")).toBe("fix-null-deref");
    expect(createRunId(UUID_V7)).toBe(UUID_V7);
    expect(createTaskRunId(UUID_V7)).toBe(UUID_V7);
    expect(createSandboxId(UUID_V7)).toBe(UUID_V7);
    expect(createBlobHash(SHA256)).toBe(SHA256);
    expect(createContentHash(SHA256)).toBe(SHA256);
    expect(createVariantName("candidate-v2")).toBe("candidate-v2");
    expect(createTrajectoryMetricId("redundant_call_count")).toBe("redundant_call_count");

    expectTypeOf(createTaskId("task-id")).toEqualTypeOf<TaskId>();
    expectTypeOf(createRunId(UUID_V7)).toEqualTypeOf<RunId>();
    expectTypeOf(createTaskRunId(UUID_V7)).toEqualTypeOf<TaskRunId>();
    expectTypeOf(createSandboxId(UUID_V7)).toEqualTypeOf<SandboxId>();
    expectTypeOf(createBlobHash(SHA256)).toEqualTypeOf<BlobHash>();
    expectTypeOf(createContentHash(SHA256)).toEqualTypeOf<ContentHash>();
    expectTypeOf(createVariantName("baseline")).toEqualTypeOf<VariantName>();
    expectTypeOf(createTrajectoryMetricId("tool_calls")).toEqualTypeOf<TrajectoryMetricId>();
  });

  it.each([
    "",
    "a",
    "A-task",
    "-leading",
    "contains/slash",
    "x".repeat(64)
  ])("rejects malformed task ids: %j", (candidate) => {
    expect(() => createTaskId(candidate)).toThrowError(/invalid_invocation/u);
  });

  it.each([
    "",
    "01890f70-6c50-6cc8-b2cb-566b786e0000",
    "01890F70-6C50-7CC8-B2CB-566B786E0000",
    "not-a-uuid"
  ])("rejects malformed UUIDv7 record ids: %j", (candidate) => {
    expect(() => createRunId(candidate)).toThrowError(/invalid_invocation/u);
    expect(() => createTaskRunId(candidate)).toThrowError(/invalid_invocation/u);
    expect(() => createSandboxId(candidate)).toThrowError(/invalid_invocation/u);
  });

  it.each(["", "ABC", "0".repeat(63), "g".repeat(64), "0".repeat(65)])(
    "rejects malformed hashes: %j",
    (candidate) => {
      expect(() => createBlobHash(candidate)).toThrowError(/invalid_invocation/u);
      expect(() => createContentHash(candidate)).toThrowError(/invalid_invocation/u);
    }
  );
});
