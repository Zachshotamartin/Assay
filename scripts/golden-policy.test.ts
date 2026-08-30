import { describe, expect, it } from "vitest";

import {
  assertGoldenReview,
  changedGoldenFiles,
  parseGoldenReviewNote
} from "./golden-policy.js";

describe("NFR-MAINT-005 golden fixture review policy", () => {
  it("detects every governed golden path without treating ordinary fixtures as goldens", () => {
    expect(
      changedGoldenFiles([
        "fixtures/goldens/r1/reference.jsonl",
        "packages/trajectory/fixtures/golden/capture.json",
        "packages/stats/src/__fixtures__/comparison.golden.json",
        "fixtures/tasks/valid/basic.yaml"
      ])
    ).toEqual([
      "fixtures/goldens/r1/reference.jsonl",
      "packages/stats/src/__fixtures__/comparison.golden.json",
      "packages/trajectory/fixtures/golden/capture.json"
    ]);
  });

  it("requires a substantive, single-line semantic review note", () => {
    expect(parseGoldenReviewNote("Golden semantic review: run ids remain byte-stable")).toBe(
      "run ids remain byte-stable"
    );
    expect(() => parseGoldenReviewNote("unrelated PR text")).toThrow(/Golden semantic review/u);
    expect(() => parseGoldenReviewNote("Golden semantic review: n\/a")).toThrow(/substantive/u);
    expect(() => parseGoldenReviewNote("Golden semantic review: regenerated")).toThrow(
      /substantive/u
    );
  });

  it("rejects golden churn without the semantic note and allows non-golden changes", () => {
    expect(() => assertGoldenReview(["fixtures/goldens/r1/result.jsonl"], "No review")).toThrow(
      /result\.jsonl/u
    );
    expect(() => assertGoldenReview(["src/result.ts"], "")).not.toThrow();
    expect(() =>
      assertGoldenReview(
        ["fixtures/goldens/r1/result.jsonl"],
        "Golden semantic review: canonical records changed only to add the declared seed"
      )
    ).not.toThrow();
  });
});
