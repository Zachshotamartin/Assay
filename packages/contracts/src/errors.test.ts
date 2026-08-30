import { describe, expect, it } from "vitest";

import {
  ASSAY_ERROR_CATEGORIES,
  AssayError,
  aggregateExitCode,
  exitCodeForCategory,
  isFailClosedCategory,
  retryPolicyForCategory,
  serializeAssayError
} from "./errors.js";

const EXIT_4 = [
  "invalid_invocation",
  "invalid_configuration",
  "task_invalid",
  "suite_invalid",
  "checker_invalid",
  "judge_uncalibrated",
  "comparison_invalid"
] as const;

const EXIT_2 = ["budget_exceeded"] as const;

const EXIT_5 = [
  "fixture_unavailable",
  "fixture_hash_mismatch",
  "adapter_unavailable",
  "adapter_protocol_error",
  "adapter_nonconformant",
  "sandbox_unavailable",
  "sandbox_start_failed",
  "sandbox_limit_exceeded",
  "sandbox_timeout",
  "provider_authentication",
  "provider_rate_limit",
  "provider_transient",
  "provider_invalid_response",
  "usage_unreconciled",
  "assertion_error",
  "judge_unavailable",
  "storage_locked",
  "storage_corrupt",
  "storage_migration_required",
  "redaction_failed",
  "internal_invariant"
] as const;

describe("Assay error taxonomy", () => {
  it("contains exactly every fixed category", () => {
    expect(ASSAY_ERROR_CATEGORIES).toHaveLength(30);
    expect(new Set(ASSAY_ERROR_CATEGORIES).size).toBe(30);
    expect(ASSAY_ERROR_CATEGORIES).toEqual([
      ...EXIT_4.slice(0, 5),
      "fixture_unavailable",
      "fixture_hash_mismatch",
      "adapter_unavailable",
      "adapter_protocol_error",
      "adapter_nonconformant",
      "sandbox_unavailable",
      "sandbox_start_failed",
      "sandbox_limit_exceeded",
      "sandbox_timeout",
      "provider_authentication",
      "provider_rate_limit",
      "provider_transient",
      "provider_invalid_response",
      "usage_unreconciled",
      "assertion_error",
      "judge_unavailable",
      "judge_uncalibrated",
      "budget_exceeded",
      "comparison_invalid",
      "storage_locked",
      "storage_corrupt",
      "storage_migration_required",
      "redaction_failed",
      "cancelled",
      "internal_invariant"
    ]);
  });

  it.each(EXIT_4)("maps %s to invalid-input exit 4", (category) => {
    expect(exitCodeForCategory(category)).toBe(4);
  });

  it.each(EXIT_2)("maps %s to budget exit 2", (category) => {
    expect(exitCodeForCategory(category)).toBe(2);
  });

  it.each(EXIT_5)("maps %s to infrastructure exit 5", (category) => {
    expect(exitCodeForCategory(category)).toBe(5);
  });

  it("maps cancellation to 6 and applies product precedence", () => {
    expect(exitCodeForCategory("cancelled")).toBe(6);
    expect(aggregateExitCode([1, 2, 3, 4, 5])).toBe(5);
    expect(aggregateExitCode([5, 6])).toBe(5);
    expect(aggregateExitCode([6, 3, 2, 1])).toBe(6);
    expect(aggregateExitCode([3, 2, 1])).toBe(3);
    expect(aggregateExitCode([])).toBe(0);
  });

  it("constructs every category and serializes only an allowlisted safe shape", () => {
    for (const category of ASSAY_ERROR_CATEGORIES) {
      const secret = new Error("sk-secret-must-not-serialize");
      const error = new AssayError(category, "safe message", {
        cause: secret,
        correlationId: "corr-123"
      });

      expect(error.category).toBe(category);
      expect(error.cause).toBe(secret);
      expect(JSON.stringify(serializeAssayError(error))).not.toContain("sk-secret");
      expect(serializeAssayError(error)).toEqual({
        category,
        message: "safe message",
        correlation_id: "corr-123",
        retry: retryPolicyForCategory(category),
        fail_closed: isFailClosedCategory(category)
      });
    }
  });

  it("fixes retry and fail-closed classifications", () => {
    expect(retryPolicyForCategory("provider_rate_limit")).toBe("bounded_jittered_backoff");
    expect(retryPolicyForCategory("provider_transient")).toBe("bounded_jittered_backoff");
    expect(retryPolicyForCategory("storage_locked")).toBe("bounded_process_backoff");
    expect(retryPolicyForCategory("sandbox_timeout")).toBe("none");
    expect(isFailClosedCategory("usage_unreconciled")).toBe(true);
    expect(isFailClosedCategory("redaction_failed")).toBe(true);
    expect(isFailClosedCategory("budget_exceeded")).toBe(false);
  });
});
