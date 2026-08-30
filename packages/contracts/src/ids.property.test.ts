import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createTaskId } from "./ids.js";

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const TASK_ID_SEED = 0x4153_5341;

describe("task identifier properties", () => {
  it("accepts every generated filesystem- and database-safe task id", () => {
    const first = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789");
    const rest = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-");
    const validTaskId = fc.tuple(first, fc.array(rest, { minLength: 1, maxLength: 62 }))
      .map(([head, tail]) => `${head}${tail.join("")}`);

    fc.assert(fc.property(validTaskId, (candidate) => {
      expect(createTaskId(candidate)).toBe(candidate);
      expect(candidate).not.toMatch(/[./\\\0]/u);
      expect(Buffer.byteLength(candidate, "utf8")).toBe(candidate.length);
    }), { seed: TASK_ID_SEED, numRuns: 1_000 });
  });

  it("rejects every generated string outside the task-id language", () => {
    const invalidTaskId = fc.string({ maxLength: 140 })
      .filter((candidate) => !TASK_ID_PATTERN.test(candidate));

    fc.assert(fc.property(invalidTaskId, (candidate) => {
      expect(() => createTaskId(candidate)).toThrowError(/invalid_invocation/u);
    }), { seed: TASK_ID_SEED, numRuns: 1_000 });
  });
});
