export const ASSAY_ERROR_CATEGORIES = [
  "invalid_invocation",
  "invalid_configuration",
  "task_invalid",
  "suite_invalid",
  "checker_invalid",
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
] as const;

export type AssayErrorCategory = (typeof ASSAY_ERROR_CATEGORIES)[number];
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RetryPolicy =
  | "none"
  | "bounded_jittered_backoff"
  | "bounded_process_backoff";

export interface AssayErrorOptions {
  readonly cause?: unknown;
  readonly correlationId?: string;
}

export class AssayError extends Error {
  readonly category: AssayErrorCategory;
  readonly correlationId: string | undefined;

  constructor(category: AssayErrorCategory, message: string, options: AssayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AssayError";
    this.category = category;
    this.correlationId = options.correlationId;
  }
}

const EXIT_CODE_BY_CATEGORY = {
  invalid_invocation: 4,
  invalid_configuration: 4,
  task_invalid: 4,
  suite_invalid: 4,
  checker_invalid: 4,
  fixture_unavailable: 5,
  fixture_hash_mismatch: 5,
  adapter_unavailable: 5,
  adapter_protocol_error: 5,
  adapter_nonconformant: 5,
  sandbox_unavailable: 5,
  sandbox_start_failed: 5,
  sandbox_limit_exceeded: 5,
  sandbox_timeout: 5,
  provider_authentication: 5,
  provider_rate_limit: 5,
  provider_transient: 5,
  provider_invalid_response: 5,
  usage_unreconciled: 2,
  assertion_error: 5,
  judge_unavailable: 5,
  judge_uncalibrated: 4,
  budget_exceeded: 2,
  comparison_invalid: 4,
  storage_locked: 5,
  storage_corrupt: 5,
  storage_migration_required: 5,
  redaction_failed: 5,
  cancelled: 6,
  internal_invariant: 5
} as const satisfies Record<AssayErrorCategory, ExitCode>;

export function exitCodeForCategory(category: AssayErrorCategory): ExitCode {
  return EXIT_CODE_BY_CATEGORY[category];
}

export function aggregateExitCode(codes: readonly ExitCode[]): ExitCode {
  if (codes.includes(6)) {
    return 6;
  }

  for (const candidate of [5, 4, 3, 2, 1] as const) {
    if (codes.includes(candidate)) {
      return candidate;
    }
  }

  return 0;
}

export function retryPolicyForCategory(category: AssayErrorCategory): RetryPolicy {
  if (category === "provider_rate_limit" || category === "provider_transient") {
    return "bounded_jittered_backoff";
  }
  if (category === "storage_locked") {
    return "bounded_process_backoff";
  }
  return "none";
}

export function isFailClosedCategory(category: AssayErrorCategory): boolean {
  return category === "usage_unreconciled" || category === "redaction_failed";
}

export interface SerializedAssayError {
  readonly category: AssayErrorCategory;
  readonly message: string;
  readonly correlation_id?: string;
  readonly retry: RetryPolicy;
  readonly fail_closed: boolean;
}

export function serializeAssayError(error: AssayError): SerializedAssayError {
  const base = {
    category: error.category,
    message: error.message,
    retry: retryPolicyForCategory(error.category),
    fail_closed: isFailClosedCategory(error.category)
  } as const;

  return error.correlationId === undefined
    ? base
    : { ...base, correlation_id: error.correlationId };
}
