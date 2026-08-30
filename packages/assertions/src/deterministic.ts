import { resolve, posix } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { evaluateDiffMatches } from "./diff-matches.js";
import type {
  AssertionExecutionContext,
  CommandExecutionResult,
  CommandOutputAssertionSpec,
  DeterministicAssertionResult,
  DeterministicAssertionSpec,
  FileContainsAssertionSpec
} from "./types.js";
import {
  AssertionSpecError,
  validateDeterministicAssertion,
  validateSafeRegex
} from "./validation.js";
import { inspectWorkspacePath, readWorkspaceFile } from "./workspace.js";

export const ASSERTION_OUTPUT_LIMIT_BYTES = 1_048_576;
const DEFAULT_FILE_CONTAINS_MAX_BYTES = 10_485_760;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_JSON_FILE_MAX_BYTES = 10_485_760;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface EvaluationValue {
  readonly observed: unknown;
  readonly expectation: unknown;
  readonly verdict: "pass" | "fail";
}

function abortError(): DOMException {
  return new DOMException("Assertion evaluation was cancelled", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function targetFor(spec: DeterministicAssertionSpec): string {
  switch (spec.type) {
    case "exit_code":
      return "agent exit code";
    case "tests_pass":
      return JSON.stringify(spec.command);
    case "file_exists":
    case "file_absent":
    case "file_contains":
    case "json_schema":
      return spec.path;
    case "diff_matches":
      return "workspace diff";
    case "command_output":
      return `${spec.stream ?? "stdout"}:${JSON.stringify(spec.command)}`;
  }
}

function expectationFor(spec: DeterministicAssertionSpec): unknown {
  switch (spec.type) {
    case "exit_code":
      return spec.equals ?? 0;
    case "tests_pass":
      return { exitCode: 0 };
    case "file_exists":
      return spec.kind ?? "file";
    case "file_absent":
      return "absent";
    case "file_contains":
      return "literal" in spec
        ? { literal: spec.literal, minCount: spec.min_count ?? 1 }
        : { regex: spec.regex, minCount: spec.min_count ?? 1 };
    case "json_schema":
      return { conformsTo: spec.schema };
    case "diff_matches":
      return {
        expectedPatch: spec.expected,
        ignoreWhitespace: spec.ignore_whitespace ?? "trailing",
        paths: spec.paths ?? "all"
      };
    case "command_output":
      if ("equals" in spec) {
        return { equals: spec.equals };
      }
      if ("contains" in spec) {
        return { contains: spec.contains };
      }
      return { regex: spec.regex };
  }
}

function countLiteral(text: string, literal: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - literal.length) {
    const found = text.indexOf(literal, offset);
    if (found < 0) {
      break;
    }
    count += 1;
    offset = found + literal.length;
  }
  return count;
}

function countRegex(text: string, pattern: string): number {
  const safe = validateSafeRegex(pattern);
  const expression = new RegExp(safe.source, "gu");
  let count = 0;
  for (const match of text.matchAll(expression)) {
    count += 1;
    if (match[0].length === 0) {
      expression.lastIndex += 1;
    }
  }
  return count;
}

function strictText(bytes: Uint8Array): string {
  const decoded = UTF8.decode(bytes);
  return decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded;
}

function observedKind(
  inspected: Awaited<ReturnType<typeof inspectWorkspacePath>>
): string {
  if (inspected.status === "absent") {
    return "absent";
  }
  if (inspected.status === "blocked_symlink") {
    return "path traverses symlink";
  }
  return inspected.kind;
}

function executionError(result: Exclude<CommandExecutionResult, { readonly status: "completed" }>): Error {
  switch (result.status) {
    case "spawn_error":
      return new Error(`command spawn failed: ${result.message}`);
    case "timeout":
      return new Error(`command timed out after ${result.timeoutMs} ms`);
    case "output_limit":
      return new Error(`${result.stream} exceeded ${result.limitBytes} bytes`);
  }
}

function mapCwd(specCwd: string | undefined, context: AssertionExecutionContext): string {
  if (specCwd === undefined) {
    return context.workspaceRoot;
  }
  if (!specCwd.startsWith("/")) {
    return resolve(context.workspaceRoot, specCwd);
  }
  const sandboxWorkdir = posix.normalize(context.sandboxWorkdir ?? "/workspace");
  const cwd = posix.normalize(specCwd);
  if (cwd !== sandboxWorkdir && !cwd.startsWith(`${sandboxWorkdir}/`)) {
    throw new Error(`absolute command cwd is outside sandbox workdir ${sandboxWorkdir}`);
  }
  const relativeCwd = posix.relative(sandboxWorkdir, cwd);
  return resolve(context.workspaceRoot, ...relativeCwd.split("/"));
}

async function runCommand(
  command: readonly string[],
  cwd: string | undefined,
  timeoutMs: number,
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<Extract<CommandExecutionResult, { readonly status: "completed" }>> {
  const result = await context.commandRunner.run({
    argv: command,
    cwd: mapCwd(cwd, context),
    timeoutMs,
    maxOutputBytes: ASSERTION_OUTPUT_LIMIT_BYTES
  }, signal);
  if (result.status !== "completed") {
    throw executionError(result);
  }
  return result;
}

async function evaluateExitCode(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "exit_code" }>,
  context: AssertionExecutionContext
): Promise<EvaluationValue> {
  const expected = spec.equals ?? 0;
  if (context.agentExitCode === null) {
    throw new Error("adapter did not report an agent termination status");
  }
  return {
    observed: context.agentExitCode,
    expectation: expected,
    verdict: context.agentExitCode === expected ? "pass" : "fail"
  };
}

async function evaluateTestsPass(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "tests_pass" }>,
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<EvaluationValue> {
  const execution = await runCommand(
    spec.command,
    spec.cwd,
    spec.timeout_ms ?? DEFAULT_TEST_TIMEOUT_MS,
    context,
    signal
  );
  return {
    observed: { exitCode: execution.exitCode },
    expectation: { exitCode: 0 },
    verdict: execution.exitCode === 0 ? "pass" : "fail"
  };
}

async function evaluateFileExists(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "file_exists" }>,
  context: AssertionExecutionContext
): Promise<EvaluationValue> {
  const expected = spec.kind ?? "file";
  const inspected = await inspectWorkspacePath(context.workspaceRoot, spec.path);
  const observed = observedKind(inspected);
  const passes = inspected.status === "present" &&
    (expected === "any" || inspected.kind === expected);
  return { observed, expectation: expected, verdict: passes ? "pass" : "fail" };
}

async function evaluateFileAbsent(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "file_absent" }>,
  context: AssertionExecutionContext
): Promise<EvaluationValue> {
  const inspected = await inspectWorkspacePath(context.workspaceRoot, spec.path);
  if (inspected.status === "blocked_symlink") {
    throw new Error(`cannot establish absence through a symlink: ${spec.path}`);
  }
  const observed = observedKind(inspected);
  return { observed, expectation: "absent", verdict: observed === "absent" ? "pass" : "fail" };
}

async function evaluateFileContains(
  spec: FileContainsAssertionSpec,
  context: AssertionExecutionContext
): Promise<EvaluationValue> {
  const expectation = expectationFor(spec);
  const maxBytes = spec.max_bytes ?? DEFAULT_FILE_CONTAINS_MAX_BYTES;
  let bytes: Uint8Array;
  try {
    bytes = await readWorkspaceFile(context.workspaceRoot, spec.path, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { observed: "file absent", expectation, verdict: "fail" };
    }
    throw error;
  }
  let text: string;
  try {
    text = strictText(bytes);
  } catch {
    return { observed: "not valid UTF-8", expectation, verdict: "fail" };
  }
  const count = "literal" in spec
    ? countLiteral(text, spec.literal)
    : countRegex(text, spec.regex);
  const minimum = spec.min_count ?? 1;
  return {
    observed: { count },
    expectation,
    verdict: count >= minimum ? "pass" : "fail"
  };
}

function containsRemoteReference(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRemoteReference);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(nested)) {
      return true;
    }
    if (containsRemoteReference(nested)) {
      return true;
    }
  }
  return false;
}

function stableAjvErrors(errors: readonly ErrorObject[]): readonly unknown[] {
  return errors.slice(0, 5).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    params: error.params,
    message: error.message ?? "validation failed"
  }));
}

async function evaluateJsonSchema(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "json_schema" }>,
  context: AssertionExecutionContext
): Promise<EvaluationValue> {
  const expectation = expectationFor(spec);
  let targetBytes: Uint8Array;
  try {
    targetBytes = await readWorkspaceFile(
      context.workspaceRoot,
      spec.path,
      DEFAULT_JSON_FILE_MAX_BYTES
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { observed: "file absent", expectation, verdict: "fail" };
    }
    throw error;
  }
  let target: unknown;
  try {
    target = JSON.parse(strictText(targetBytes)) as unknown;
  } catch {
    return { observed: "invalid JSON", expectation, verdict: "fail" };
  }
  const validator = await compileJsonSchema(spec, context.projectRoot);
  if (validator(target)) {
    return { observed: "conformant", expectation, verdict: "pass" };
  }
  return {
    observed: stableAjvErrors(validator.errors ?? []),
    expectation,
    verdict: "fail"
  };
}

async function compileJsonSchema(
  spec: Extract<DeterministicAssertionSpec, { readonly type: "json_schema" }>,
  projectRoot: string
): Promise<ValidateFunction<unknown>> {
  const schemaBytes = await readWorkspaceFile(
    projectRoot,
    spec.schema,
    DEFAULT_JSON_FILE_MAX_BYTES
  );
  let schema: unknown;
  try {
    schema = JSON.parse(strictText(schemaBytes)) as unknown;
  } catch {
    throw new Error(`JSON Schema is not valid JSON: ${spec.schema}`);
  }
  if (containsRemoteReference(schema)) {
    throw new Error(`JSON Schema contains a remote $ref: ${spec.schema}`);
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  return ajv.compile(schema as object) as ValidateFunction<unknown>;
}

export async function validateJsonSchemaAssertion(
  uncheckedSpec: unknown,
  projectRoot: string
): Promise<void> {
  validateDeterministicAssertion(uncheckedSpec);
  if (uncheckedSpec.type !== "json_schema") {
    throw new AssertionSpecError(
      "json-schema",
      "task_invalid: JSON Schema preflight requires a json_schema assertion"
    );
  }
  try {
    await compileJsonSchema(uncheckedSpec, projectRoot);
  } catch (cause) {
    throw new AssertionSpecError(
      "json-schema",
      `task_invalid: JSON Schema preflight failed for ${uncheckedSpec.schema}`,
      cause
    );
  }
}

function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function commandOutputMatches(spec: CommandOutputAssertionSpec, observed: string): boolean {
  if ("equals" in spec) {
    return observed === spec.equals;
  }
  if ("contains" in spec) {
    return observed.includes(spec.contains);
  }
  return validateSafeRegex(spec.regex).test(observed);
}

async function evaluateCommandOutput(
  spec: CommandOutputAssertionSpec,
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<EvaluationValue> {
  const execution = await runCommand(
    spec.command,
    spec.cwd,
    spec.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    context,
    signal
  );
  const stream = spec.stream ?? "stdout";
  const raw = stream === "stdout"
    ? execution.stdout
    : stream === "stderr"
      ? execution.stderr
      : `${execution.stdout}${execution.stderr}`;
  const observed = stripOneTrailingNewline(raw);
  return {
    observed,
    expectation: expectationFor(spec),
    verdict: commandOutputMatches(spec, observed) ? "pass" : "fail"
  };
}

async function evaluateValue(
  spec: DeterministicAssertionSpec,
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<EvaluationValue> {
  switch (spec.type) {
    case "exit_code":
      return evaluateExitCode(spec, context);
    case "tests_pass":
      return evaluateTestsPass(spec, context, signal);
    case "file_exists":
      return evaluateFileExists(spec, context);
    case "file_absent":
      return evaluateFileAbsent(spec, context);
    case "file_contains":
      return evaluateFileContains(spec, context);
    case "json_schema":
      return evaluateJsonSchema(spec, context);
    case "diff_matches": {
      const result = await evaluateDiffMatches(spec, context);
      return {
        observed: result.observed,
        expectation: expectationFor(spec),
        verdict: result.matches ? "pass" : "fail"
      };
    }
    case "command_output":
      return evaluateCommandOutput(spec, context, signal);
  }
}

function duration(context: AssertionExecutionContext, start: number): number {
  const elapsed = context.clock.monotonicMilliseconds() - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error("assertion clock moved backwards or returned a non-finite duration");
  }
  return elapsed;
}

export async function evaluateDeterministicAssertion(
  uncheckedSpec: unknown,
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<DeterministicAssertionResult> {
  validateDeterministicAssertion(uncheckedSpec);
  const spec = uncheckedSpec;
  throwIfAborted(signal);
  const start = context.clock.monotonicMilliseconds();
  try {
    const value = await evaluateValue(spec, context, signal);
    throwIfAborted(signal);
    return {
      type: spec.type,
      target: targetFor(spec),
      observed: value.observed,
      expectation: value.expectation,
      verdict: value.verdict,
      durationMs: duration(context, start)
    };
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw abortError();
    }
    return {
      type: spec.type,
      target: targetFor(spec),
      observed: {
        error: error instanceof Error ? error.message : "assertion evaluation failed"
      },
      expectation: expectationFor(spec),
      verdict: "error",
      durationMs: duration(context, start),
      errorCategory: "assertion_error",
      message: error instanceof Error ? error.message : "assertion evaluation failed"
    };
  }
}

export async function evaluateDeterministicAssertions(
  specs: readonly unknown[],
  context: AssertionExecutionContext,
  signal: AbortSignal
): Promise<readonly DeterministicAssertionResult[]> {
  const results: DeterministicAssertionResult[] = [];
  for (const spec of specs) {
    throwIfAborted(signal);
    results.push(await evaluateDeterministicAssertion(spec, context, signal));
  }
  return results;
}
