import { isAbsolute, posix, win32 } from "node:path";

import { AssayError } from "@assay/contracts";

import type {
  CommandOutputAssertionSpec,
  DeterministicAssertionSpec,
  DiffMatchesAssertionSpec,
  FileContainsAssertionSpec
} from "./types.js";

const ASSERTION_NAMES = new Set([
  "exit_code",
  "tests_pass",
  "file_exists",
  "file_absent",
  "file_contains",
  "json_schema",
  "diff_matches",
  "command_output"
]);
const KINDS = new Set(["file", "dir", "any"]);
const STREAMS = new Set(["stdout", "stderr", "both"]);
const WHITESPACE_MODES = new Set(["none", "trailing", "all"]);
const MAX_REGEX_LENGTH = 4_096;

export class AssertionSpecError extends AssayError {
  readonly code: string;

  constructor(code: string, message: string) {
    super("task_invalid", message);
    this.name = "AssertionSpecError";
    this.code = `task_invalid/${code}`;
  }
}

function invalid(code: string, message: string): never {
  throw new AssertionSpecError(code, `task_invalid: ${message}`);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("assertion-shape", "assertion must be a mapping");
  }
  return value as Readonly<Record<string, unknown>>;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort()[0];
  if (unknown !== undefined) {
    invalid("assertion-field", `unknown assertion field ${JSON.stringify(unknown)}`);
  }
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid(
      "assertion-field",
      `${field} must be an integer from ${minimum} through ${maximum}`
    );
  }
  return value as number;
}

function optionalName(value: Readonly<Record<string, unknown>>): void {
  const name = value["name"];
  if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 64)) {
    invalid("assertion-field", "name must contain 1 through 64 characters");
  }
}

export function validateWorkspacePath(path: unknown, field = "path"): string {
  if (typeof path !== "string" || path.length === 0) {
    return invalid("path", `${field} must be a non-empty workspace-relative path`);
  }
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return invalid("path-escape", `${field} must use a workspace-relative forward-slash path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    return invalid("path-escape", `${field} must not contain a '..' segment`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    return invalid("path", `${field} must not contain empty path segments`);
  }
  return path;
}

export function validateProjectPath(path: unknown, field: string): string {
  return validateWorkspacePath(path, field);
}

function validateCwd(cwd: unknown): void {
  if (cwd === undefined) {
    return;
  }
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0") || cwd.includes("\\")) {
    invalid("command-cwd", "cwd must be a non-empty forward-slash path");
  }
  const normalized = posix.normalize(cwd as string);
  const segments = (cwd as string).split("/");
  if (segments.some((segment) => segment === "..") || normalized === ".." || normalized.startsWith("../")) {
    invalid("path-escape", "cwd must remain inside the workspace");
  }
  if (win32.isAbsolute(cwd as string) || /^[A-Za-z]:/u.test(cwd as string)) {
    invalid("path-escape", "cwd must not be a host absolute path");
  }
}

function validateCommand(command: unknown): readonly string[] {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string") ||
    typeof command[0] !== "string" ||
    command[0].length === 0
  ) {
    return invalid("command", "command must be a non-empty argv string array");
  }
  if (command.some((entry) => entry.includes("\0"))) {
    return invalid("command", "command argv must not contain NUL bytes");
  }
  return command;
}

export function validateSafeRegex(pattern: unknown, field = "regex"): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_REGEX_LENGTH) {
    return invalid("regex", `${field} must contain 1 through ${MAX_REGEX_LENGTH} characters`);
  }
  if (/\\[1-9]/u.test(pattern)) {
    return invalid("regex-complexity", `${field} must not use backreferences`);
  }
  if (/\(\?(?:[=!]|<[=!]|<[^>]+>)/u.test(pattern)) {
    return invalid("regex-complexity", `${field} must not use lookaround or named captures`);
  }
  if (/\((?:[^()\\]|\\.)*[*+{](?:[^()\\]|\\.)*\)[*+{?]/u.test(pattern)) {
    return invalid("regex-complexity", `${field} contains a nested quantified group`);
  }
  if (/\.\*(?:[^|)]*\.\*)/u.test(pattern)) {
    return invalid("regex-complexity", `${field} contains repeated unbounded wildcards`);
  }
  try {
    return new RegExp(pattern, "u");
  } catch (error) {
    void error;
    return invalid("regex-syntax", `${field} is not a valid Unicode regular expression`);
  }
}

function validateFileContains(value: Readonly<Record<string, unknown>>): void {
  rejectUnknownKeys(value, new Set(["type", "name", "path", "literal", "regex", "min_count", "max_bytes"]));
  validateWorkspacePath(value["path"]);
  const literal = value["literal"];
  const regex = value["regex"];
  if ((typeof literal === "string") === (typeof regex === "string")) {
    invalid("assertion-matcher", "file_contains requires exactly one of literal or regex");
  }
  if (literal !== undefined && (typeof literal !== "string" || literal.length === 0)) {
    invalid("assertion-matcher", "file_contains literal must be non-empty");
  }
  if (regex !== undefined) {
    validateSafeRegex(regex);
  }
  if (value["min_count"] !== undefined) {
    integer(value["min_count"], "min_count", 1, Number.MAX_SAFE_INTEGER);
  }
  if (value["max_bytes"] !== undefined) {
    integer(value["max_bytes"], "max_bytes", 1, Number.MAX_SAFE_INTEGER);
  }
}

function validateCommandOutput(value: Readonly<Record<string, unknown>>): void {
  rejectUnknownKeys(value, new Set([
    "type", "name", "command", "stream", "equals", "contains", "regex", "cwd", "timeout_ms"
  ]));
  validateCommand(value["command"]);
  validateCwd(value["cwd"]);
  if (value["timeout_ms"] !== undefined) {
    integer(value["timeout_ms"], "timeout_ms", 1_000, 3_600_000);
  }
  if (value["stream"] !== undefined && !STREAMS.has(value["stream"] as string)) {
    invalid("assertion-field", "stream must be stdout, stderr, or both");
  }
  const matcherFields = ["equals", "contains", "regex"].filter(
    (field) => typeof value[field] === "string"
  );
  if (matcherFields.length !== 1) {
    invalid("assertion-matcher", "command_output requires exactly one of equals, contains, or regex");
  }
  for (const field of ["equals", "contains", "regex"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      invalid("assertion-matcher", `${field} must be a string`);
    }
  }
  if (typeof value["regex"] === "string") {
    validateSafeRegex(value["regex"]);
  }
}

export function validateDeterministicAssertion(
  spec: unknown
): asserts spec is DeterministicAssertionSpec {
  const value = record(spec);
  const type = value["type"];
  if (typeof type !== "string" || !ASSERTION_NAMES.has(type)) {
    invalid("assertion-type", "assertion type is not one of the eight deterministic types");
  }
  optionalName(value);

  switch (type) {
    case "exit_code":
      rejectUnknownKeys(value, new Set(["type", "name", "equals"]));
      if (value["equals"] !== undefined) {
        integer(value["equals"], "equals", 0, 255);
      }
      return;
    case "tests_pass":
      rejectUnknownKeys(value, new Set(["type", "name", "command", "cwd", "timeout_ms"]));
      validateCommand(value["command"]);
      validateCwd(value["cwd"]);
      if (value["timeout_ms"] !== undefined) {
        integer(value["timeout_ms"], "timeout_ms", 1_000, 3_600_000);
      }
      return;
    case "file_exists":
      rejectUnknownKeys(value, new Set(["type", "name", "path", "kind"]));
      validateWorkspacePath(value["path"]);
      if (value["kind"] !== undefined && !KINDS.has(value["kind"] as string)) {
        invalid("assertion-field", "kind must be file, dir, or any");
      }
      return;
    case "file_absent":
      rejectUnknownKeys(value, new Set(["type", "name", "path"]));
      validateWorkspacePath(value["path"]);
      return;
    case "file_contains":
      validateFileContains(value);
      return;
    case "json_schema":
      rejectUnknownKeys(value, new Set(["type", "name", "path", "schema"]));
      validateWorkspacePath(value["path"]);
      validateProjectPath(value["schema"], "schema");
      return;
    case "diff_matches":
      rejectUnknownKeys(value, new Set(["type", "name", "expected", "ignore_whitespace", "paths"]));
      validateProjectPath(value["expected"], "expected");
      if (value["ignore_whitespace"] !== undefined &&
          !WHITESPACE_MODES.has(value["ignore_whitespace"] as string)) {
        invalid("assertion-field", "ignore_whitespace must be none, trailing, or all");
      }
      if (value["paths"] !== undefined) {
        if (!Array.isArray(value["paths"]) || value["paths"].length === 0) {
          invalid("assertion-field", "paths must be a non-empty list");
        }
        const seen = new Set<string>();
        for (const path of value["paths"] as readonly unknown[]) {
          const validated = validateWorkspacePath(path, "paths entry");
          if (seen.has(validated)) {
            invalid("assertion-field", `paths contains duplicate ${JSON.stringify(validated)}`);
          }
          seen.add(validated);
        }
      }
      return;
    case "command_output":
      validateCommandOutput(value);
      return;
    default:
      return invalid("assertion-type", "unreachable assertion type");
  }
}

export function validatedFileContainsSpec(spec: unknown): FileContainsAssertionSpec {
  validateDeterministicAssertion(spec);
  if (spec.type !== "file_contains") {
    return invalid("assertion-type", "expected a file_contains assertion");
  }
  return spec;
}

export function validatedCommandOutputSpec(spec: unknown): CommandOutputAssertionSpec {
  validateDeterministicAssertion(spec);
  if (spec.type !== "command_output") {
    return invalid("assertion-type", "expected a command_output assertion");
  }
  return spec;
}

export function validatedDiffMatchesSpec(spec: unknown): DiffMatchesAssertionSpec {
  validateDeterministicAssertion(spec);
  if (spec.type !== "diff_matches") {
    return invalid("assertion-type", "expected a diff_matches assertion");
  }
  return spec;
}
