import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  validateAssertionLayerOrder,
  validateCheckerModule,
  type CheckerAssertionSpec
} from "@assay/assertions";
import {
  ASSAY_ERROR_CATEGORIES,
  AssayError,
  exitCodeForCategory,
  type AssayErrorCategory
} from "@assay/contracts";
import {
  DEFAULT_MAX_REDACTION_INPUT_BYTES,
  RedactionError,
  redactText
} from "@assay/redaction";
import {
  expandMatrix,
  expandSuiteInclude,
  inspectYamlBytes,
  loadMatrix,
  loadTask,
  locateYamlPath,
  resolveSuite,
  resolveTaskInheritance,
  taskContentHash,
  type HashedResolvedTask,
  type LoadedYaml,
  type MatrixDocument,
  type ResolvedSuite,
  type ResolvedTask,
  type RubricDocument,
  type SuiteDocument,
  type TaskDocument,
  type YamlKind
} from "@assay/task-format";

import {
  normalizeAssertion,
  resolveFixture,
  resolvePrompt
} from "./project.js";
import type { CliRuntime } from "./runtime.js";

const DISCOVERY_EXCLUSIONS = new Set([".assay", ".git", "node_modules"]);
const FILE_BASENAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_CALIBRATION_BYTES = 16 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type ValidationKind = YamlKind | "checker";

export interface ValidationSummary {
  readonly suites: number;
  readonly tasks: number;
  readonly matrices: number;
  readonly checkers: number;
  readonly rubrics: number;
}

interface ValidationFinding {
  readonly category: AssayErrorCategory;
  readonly filePath: string;
  readonly yamlPath: string;
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
  readonly line: number;
  readonly column: number;
}

const TRUSTED_VALIDATION_DIAGNOSTIC_CODES = new Set<string>([
  ...ASSAY_ERROR_CATEGORIES,
  "task_invalid/file-name",
  "task_invalid/file-unreadable",
  "task_invalid/reference-unavailable",
  "task_invalid/reference-kind",
  "task_invalid/path-escape",
  "task_invalid/file-too-large",
  "task_invalid/utf8",
  "task_invalid/yaml-parse",
  "task_invalid/format-version-unsupported",
  "task_invalid/schema",
  "task_invalid/content-hash",
  "task_invalid/append-conflict",
  "task_invalid/append-without-extends",
  "task_invalid/extends-cycle",
  "task_invalid/extends-depth",
  "task_invalid/extends-unresolved",
  "task_invalid/inherited-identity",
  "task_invalid/matrix-exclude",
  "task_invalid/matrix-placeholder",
  "task_invalid/matrix-instance",
  "task_invalid/matrix-task-mismatch",
  "task_invalid/matrix-base-unresolved",
  "task_invalid/matrix-size",
  "task_invalid/matrix-empty",
  "task_invalid/matrix-id-length",
  "task_invalid/matrix-id-collision",
  "task_invalid/assertion-layer-order",
  "task_invalid/assertion-shape",
  "task_invalid/assertion-field",
  "task_invalid/assertion-matcher",
  "task_invalid/assertion-type",
  "task_invalid/command",
  "task_invalid/command-cwd",
  "task_invalid/path",
  "task_invalid/regex",
  "task_invalid/regex-complexity",
  "task_invalid/regex-syntax",
  "task_invalid/rubric-criteria-id-duplicate",
  "task_invalid/rubric-weight-sum",
  "task_invalid/rubric-calibration-path",
  "task_invalid/rubric-calibration-unavailable",
  "task_invalid/rubric-calibration-jsonl",
  "task_invalid/rubric-calibration-size",
  "task_invalid/rubric-calibration-count",
  "task_invalid/rubric-calibration-unreadable",
  "task_invalid/judge-rubric",
  "suite_invalid/file-name",
  "suite_invalid/file-unreadable",
  "suite_invalid/reference-unavailable",
  "suite_invalid/reference-kind",
  "suite_invalid/path-escape",
  "suite_invalid/file-too-large",
  "suite_invalid/utf8",
  "suite_invalid/yaml-parse",
  "suite_invalid/format-version-unsupported",
  "suite_invalid/schema",
  "suite_invalid/include-syntax",
  "suite_invalid/include-unmatched",
  "suite_invalid/include-kind",
  "suite_invalid/abstract-direct",
  "suite_invalid/empty",
  "suite_invalid/duplicate-id",
  "suite_invalid/comparison-baseline",
  "suite_invalid/comparison-candidate",
  "suite_invalid/comparison-distinct",
  "checker_invalid/file-name",
  "checker_invalid/schema",
  "checker_invalid/path",
  "checker_invalid/path-escape",
  "checker_invalid/import-path-escape",
  "checker_invalid/import-restriction",
  "checker_invalid/module-unreadable",
  "checker_invalid/typecheck",
  "checker_invalid/export",
  "checker_invalid/signature",
  "judge_uncalibrated/agreement-record"
]);

export class ValidationDiagnosticsError extends AssayError {
  readonly findings: readonly ValidationFinding[];

  constructor(category: AssayErrorCategory, findings: readonly ValidationFinding[]) {
    super(
      category,
      `${category}: validation found ${findings.length} diagnostic${findings.length === 1 ? "" : "s"}; nothing ran`
    );
    this.name = "ValidationDiagnosticsError";
    this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
  }
}

function redactDiagnosticField(value: string, location: string): string {
  return redactText(value, { location }).value;
}

export function renderValidationDiagnostics(error: ValidationDiagnosticsError): string {
  const rendered = error.findings.map((finding, index) => {
    const baseLocation = `/diagnostic/findings/${index}`;
    const filePath = redactDiagnosticField(finding.filePath, `${baseLocation}/file_path`);
    const yamlPath = redactDiagnosticField(finding.yamlPath, `${baseLocation}/yaml_path`);
    const code = TRUSTED_VALIDATION_DIAGNOSTIC_CODES.has(finding.code)
      ? finding.code
      : redactDiagnosticField(finding.code, `${baseLocation}/code`);
    const message = redactDiagnosticField(finding.message, `${baseLocation}/message`);
    const remedy = redactDiagnosticField(finding.remedy, `${baseLocation}/remedy`);
    return `${filePath}:${finding.line}:${finding.column} ${yamlPath} ${code}: ` +
      `${message} Remedy: ${remedy}`;
  });
  const output =
    `${error.category}: validation found ${error.findings.length} ` +
    `diagnostic${error.findings.length === 1 ? "" : "s"}; nothing ran:\n` +
    rendered.join("\n");
  if (Buffer.byteLength(output, "utf8") > DEFAULT_MAX_REDACTION_INPUT_BYTES) {
    throw new RedactionError("text validation");
  }
  return output;
}

interface Candidate {
  readonly path: string;
  readonly kind: ValidationKind;
}

interface YamlState {
  readonly path: string;
  readonly kind: YamlKind;
  readonly source: string | undefined;
  readonly document: Readonly<Record<string, unknown>> | undefined;
  readonly loaded: LoadedYaml<Readonly<Record<string, unknown>>> | undefined;
  readonly hasDiagnostics: boolean;
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function projectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function categoryFor(kind: ValidationKind): "task_invalid" | "suite_invalid" | "checker_invalid" {
  if (kind === "suite") return "suite_invalid";
  if (kind === "checker") return "checker_invalid";
  return "task_invalid";
}

function suffixFor(kind: ValidationKind): string {
  switch (kind) {
    case "task": return ".task.yaml";
    case "suite": return ".suite.yaml";
    case "matrix": return ".matrix.yaml";
    case "rubric": return ".rubric.yaml";
    case "checker": return ".checker.ts";
  }
}

function kindFor(path: string): ValidationKind | undefined {
  if (path.endsWith(".task.yaml")) return "task";
  if (path.endsWith(".suite.yaml")) return "suite";
  if (path.endsWith(".matrix.yaml")) return "matrix";
  if (path.endsWith(".rubric.yaml")) return "rubric";
  if (path.endsWith(".checker.ts")) return "checker";
  return undefined;
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(projectRoot));
  } catch (cause) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: project root ${JSON.stringify(projectRoot)} is unavailable; nothing ran; choose an existing project directory`,
      { cause }
    );
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new AssayError(
      "invalid_invocation",
      "invalid_invocation: project root is not a directory; nothing ran; choose an existing project directory"
    );
  }
  return canonical;
}

async function canonicalInputPath(projectRoot: string, input: string): Promise<string> {
  const lexical = resolve(projectRoot, input);
  if (!contained(projectRoot, lexical)) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: validation path escapes the project root: ${input}; nothing ran; use an in-project path`
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch (cause) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: validation path is unavailable: ${input}; nothing ran; correct the path`,
      { cause }
    );
  }
  if (!contained(projectRoot, canonical)) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: validation path resolves outside the project root: ${input}; nothing ran; remove the escaping symlink`
    );
  }
  return canonical;
}

async function walkValidationFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => byteCompare(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && DISCOVERY_EXCLUSIONS.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const kind = kindFor(path);
        if (kind !== undefined && kind !== "checker") paths.push(path);
      }
    }
  };
  await visit(root);
  return paths.sort(byteCompare);
}

function validateGlobSyntax(projectRoot: string, pattern: string): void {
  if (pattern.includes("\\") || pattern.includes("?") || /[\[\]]/u.test(pattern)) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: validate glob uses unsupported syntax: ${pattern}; nothing ran; use * or ** with forward slashes`
    );
  }
  const wildcard = pattern.indexOf("*");
  const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  const staticPrefix = slash < 0 ? "." : prefix.slice(0, slash + 1);
  if (!contained(projectRoot, resolve(projectRoot, staticPrefix))) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: validate glob escapes the project root: ${pattern}; nothing ran; use an in-project glob`
    );
  }
}

async function validationInputs(
  projectRoot: string,
  inputs: readonly string[]
): Promise<readonly string[]> {
  if (inputs.length === 0) return await walkValidationFiles(projectRoot);
  const paths = new Set<string>();
  for (const input of inputs) {
    if (input.includes("*")) {
      validateGlobSyntax(projectRoot, input);
      const syntheticSuite = resolve(projectRoot, ".assay-validation.suite.yaml");
      const matches = await expandSuiteInclude(syntheticSuite, input, projectRoot);
      if (matches.length === 0) {
        throw new AssayError(
          "invalid_invocation",
          `invalid_invocation: validate glob matched no files: ${input}; nothing ran; correct the glob`
        );
      }
      for (const match of matches) paths.add(await canonicalInputPath(projectRoot, match));
      continue;
    }
    const path = await canonicalInputPath(projectRoot, input);
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const child of await walkValidationFiles(path)) paths.add(child);
    } else if (metadata.isFile()) {
      paths.add(path);
    } else {
      throw new AssayError(
        "invalid_invocation",
        `invalid_invocation: validation input is not a regular file or directory: ${input}; nothing ran; choose a file or directory`
      );
    }
  }
  return [...paths].sort(byteCompare);
}

function hashed(task: ResolvedTask): HashedResolvedTask {
  return { ...task, contentHash: taskContentHash(task.document) };
}

function taskKey(task: HashedResolvedTask): string {
  return `${task.path}\0${String(task.document["id"])}`;
}

function validationError(
  category: AssayErrorCategory,
  code: string,
  message: string,
  filePath: string,
  yamlPath: string,
  remedy: string
): AssayError & {
  readonly code: string;
  readonly filePath: string;
  readonly yamlPath: string;
  readonly remedy: string;
} {
  return Object.assign(new AssayError(category, `${category}: ${message}`), {
    code,
    filePath,
    yamlPath,
    remedy
  });
}

export async function validateProjectInputs(
  runtime: CliRuntime,
  inputs: readonly string[]
): Promise<ValidationSummary> {
  const projectRoot = await canonicalProjectRoot(runtime.projectRoot);
  const initialPaths = await validationInputs(projectRoot, inputs);
  if (initialPaths.length === 0) {
    throw new AssayError(
      "invalid_invocation",
      "invalid_invocation: validation discovered no task, suite, rubric, or matrix files; nothing ran; pass a populated project path"
    );
  }

  const findings: ValidationFinding[] = [];
  const sources = new Map<string, string>();
  const states = new Map<string, YamlState>();
  const candidates = new Map<string, Candidate>();
  const pending = new Set<string>();

  const position = (filePath: string, yamlPath: string): { readonly line: number; readonly column: number } => {
    const source = sources.get(resolve(filePath));
    if (source === undefined || !filePath.endsWith(".yaml")) return { line: 1, column: 1 };
    try {
      return locateYamlPath(source, yamlPath);
    } catch {
      return { line: 1, column: 1 };
    }
  };

  const addFinding = (finding: Omit<ValidationFinding, "line" | "column"> & {
    readonly line?: number;
    readonly column?: number;
  }): void => {
    const located = position(finding.filePath, finding.yamlPath);
    findings.push({
      category: finding.category,
      filePath: resolve(finding.filePath),
      yamlPath: finding.yamlPath,
      code: finding.code,
      message: finding.message,
      remedy: finding.remedy,
      line: finding.line ?? located.line,
      column: finding.column ?? located.column
    });
  };

  const recordError = (
    error: unknown,
    fallbackPath: string,
    overrides: { readonly filePath?: string; readonly yamlPath?: string } = {}
  ): void => {
    const classified = error instanceof AssayError
      ? error
      : new AssayError(
          "internal_invariant",
          "internal_invariant: validation subsystem threw an unclassified error",
          { cause: error }
        );
    const detailed = classified as AssayError & {
      readonly code?: string;
      readonly filePath?: string;
      readonly yamlPath?: string;
      readonly line?: number;
      readonly column?: number;
      readonly remedy?: string;
    };
    addFinding({
      category: classified.category,
      filePath: overrides.filePath ?? detailed.filePath ?? fallbackPath,
      yamlPath: overrides.yamlPath ?? detailed.yamlPath ?? "$",
      code: detailed.code ?? classified.category,
      message: classified.message,
      remedy: detailed.remedy ?? "Correct the reported input and run assay validate again.",
      ...(detailed.line === undefined ? {} : { line: detailed.line }),
      ...(detailed.column === undefined ? {} : { column: detailed.column })
    });
  };

  const addCandidate = async (
    pathInput: string,
    expectedKinds?: readonly ValidationKind[],
    reference?: {
      readonly filePath: string;
      readonly yamlPath: string;
      readonly category: "task_invalid" | "suite_invalid";
      readonly display: string;
    }
  ): Promise<string | undefined> => {
    let canonical: string;
    try {
      canonical = await realpath(resolve(pathInput));
      if (!contained(projectRoot, canonical)) {
        throw new Error("resolved outside the project root");
      }
      if (!(await stat(canonical)).isFile()) throw new Error("target is not a regular file");
    } catch (cause) {
      if (reference === undefined) throw cause;
      recordError(validationError(
        reference.category,
        `${reference.category}/reference-unavailable`,
        `referenced path is unavailable: ${reference.display}`,
        reference.filePath,
        reference.yamlPath,
        "Restore the local referenced file or correct its relative path."
      ), reference.filePath);
      return undefined;
    }
    const kind = kindFor(canonical);
    if (kind === undefined || (expectedKinds !== undefined && !expectedKinds.includes(kind))) {
      if (reference === undefined) {
        throw new AssayError(
          "invalid_invocation",
          `invalid_invocation: unknown validation file kind: ${pathInput}; nothing ran; use a published Assay suffix`
        );
      }
      recordError(validationError(
        reference.category,
        `${reference.category}/reference-kind`,
        `referenced path has the wrong file kind: ${reference.display}`,
        reference.filePath,
        reference.yamlPath,
        `Use a ${expectedKinds?.map(suffixFor).join(" or ")} file.`
      ), reference.filePath);
      return undefined;
    }
    if (!candidates.has(canonical)) {
      candidates.set(canonical, { path: canonical, kind });
      pending.add(canonical);
    }
    return canonical;
  };

  const addRelativeReference = async (
    origin: string,
    referenceValue: string,
    expectedKinds: readonly ValidationKind[],
    context: {
      readonly filePath: string;
      readonly yamlPath: string;
      readonly category: "task_invalid" | "suite_invalid";
    }
  ): Promise<string | undefined> => {
    if (isAbsolute(referenceValue)) {
      recordError(validationError(
        context.category,
        `${context.category}/path-escape`,
        `reference must be relative: ${referenceValue}`,
        context.filePath,
        context.yamlPath,
        "Use a relative path that remains inside the project root."
      ), context.filePath);
      return undefined;
    }
    const lexical = resolve(dirname(origin), referenceValue);
    if (!contained(projectRoot, lexical)) {
      recordError(validationError(
        context.category,
        `${context.category}/path-escape`,
        `reference escapes the project root: ${referenceValue}`,
        context.filePath,
        context.yamlPath,
        "Use a relative path that remains inside the project root."
      ), context.filePath);
      return undefined;
    }
    return await addCandidate(lexical, expectedKinds, { ...context, display: referenceValue });
  };

  for (const path of initialPaths) await addCandidate(path);

  const inspectCandidate = async (candidate: Candidate): Promise<void> => {
    const suffix = suffixFor(candidate.kind);
    const stem = basename(candidate.path).slice(0, -suffix.length);
    if (!FILE_BASENAME.test(stem)) {
      recordError(validationError(
        categoryFor(candidate.kind),
        `${categoryFor(candidate.kind)}/file-name`,
        `file basename ${JSON.stringify(stem)} does not match ^[a-z0-9][a-z0-9-]{0,62}$`,
        candidate.path,
        "$",
        "Rename the file using lowercase letters, digits, and single hyphens."
      ), candidate.path);
    }
    if (candidate.kind === "checker") return;

    let bytes: Uint8Array;
    try {
      bytes = await readFile(candidate.path);
    } catch (cause) {
      recordError(validationError(
        categoryFor(candidate.kind),
        `${categoryFor(candidate.kind)}/file-unreadable`,
        "validation file could not be read",
        candidate.path,
        "$",
        "Restore read permission and retry validation."
      ), candidate.path);
      return;
    }
    const inspected = inspectYamlBytes(bytes, candidate.path, candidate.kind);
    if (inspected.source !== undefined) sources.set(candidate.path, inspected.source);
    for (const diagnostic of inspected.diagnostics) recordError(diagnostic, candidate.path);
    states.set(candidate.path, {
      path: candidate.path,
      kind: candidate.kind,
      source: inspected.source,
      document: inspected.document,
      loaded: inspected.loaded,
      hasDiagnostics: inspected.diagnostics.length > 0
    });
    const document = inspected.document;
    if (document === undefined) return;

    if (candidate.kind === "task") {
      const parent = document["extends"];
      if (typeof parent === "string") {
        await addRelativeReference(candidate.path, parent, ["task"], {
          filePath: candidate.path,
          yamlPath: "$.extends",
          category: "task_invalid"
        });
      }
      const judge = asRecord(document["judge"]);
      if (typeof judge["rubric"] === "string") {
        await addRelativeReference(candidate.path, judge["rubric"], ["rubric"], {
          filePath: candidate.path,
          yamlPath: "$.judge.rubric",
          category: "task_invalid"
        });
      }
      const assertions = Array.isArray(document["assertions"]) ? document["assertions"] : [];
      for (const [index, value] of assertions.entries()) {
        const assertion = asRecord(value);
        if (assertion["type"] === "checker" && typeof assertion["module"] === "string") {
          await addRelativeReference(candidate.path, assertion["module"], ["checker"], {
            filePath: candidate.path,
            yamlPath: `$.assertions[${index}].module`,
            category: "task_invalid"
          });
        }
        if (assertion["type"] === "judge" && typeof assertion["rubric"] === "string") {
          await addRelativeReference(candidate.path, assertion["rubric"], ["rubric"], {
            filePath: candidate.path,
            yamlPath: `$.assertions[${index}].rubric`,
            category: "task_invalid"
          });
        }
      }
      return;
    }

    if (candidate.kind === "matrix") {
      const task = document["task"];
      if (typeof task === "string") {
        await addRelativeReference(candidate.path, task, ["task"], {
          filePath: candidate.path,
          yamlPath: "$.task",
          category: "task_invalid"
        });
      }
      return;
    }

    if (candidate.kind === "suite") {
      const includes = Array.isArray(document["include"]) ? document["include"] : [];
      for (const [index, include] of includes.entries()) {
        if (typeof include !== "string") continue;
        const yamlPath = `$.include[${index}]`;
        if (include.includes("\\") || include.includes("?") || /[\[\]]/u.test(include)) {
          recordError(validationError(
            "suite_invalid",
            "suite_invalid/include-syntax",
            `suite include uses unsupported glob syntax: ${include}`,
            candidate.path,
            yamlPath,
            "Use forward slashes with literal paths, * within one segment, or ** across segments."
          ), candidate.path);
          continue;
        }
        const wildcard = include.indexOf("*");
        const prefix = wildcard < 0 ? include : include.slice(0, wildcard);
        const slash = prefix.lastIndexOf("/");
        const staticPrefix = slash < 0 ? "." : prefix.slice(0, slash + 1);
        if (!contained(projectRoot, resolve(dirname(candidate.path), staticPrefix))) {
          recordError(validationError(
            "suite_invalid",
            "suite_invalid/path-escape",
            `suite include escapes the project root: ${include}`,
            candidate.path,
            yamlPath,
            "Use a relative include whose targets stay inside the project root."
          ), candidate.path);
          continue;
        }
        let matches: readonly string[] = [];
        try {
          matches = await expandSuiteInclude(candidate.path, include, projectRoot);
        } catch (cause) {
          recordError(cause, candidate.path, { yamlPath });
          continue;
        }
        if (matches.length === 0 && !include.includes("*")) {
          recordError(validationError(
            "suite_invalid",
            "suite_invalid/include-unmatched",
            `suite include path matched no file: ${include}`,
            candidate.path,
            yamlPath,
            "Correct the direct include path or remove it."
          ), candidate.path);
        }
        for (const match of matches) {
          await addCandidate(match, ["task", "matrix"], {
            filePath: candidate.path,
            yamlPath,
            category: "suite_invalid",
            display: include
          });
        }
      }
    }
  };

  while (pending.size > 0) {
    const path = [...pending].sort(byteCompare)[0]!;
    pending.delete(path);
    await inspectCandidate(candidates.get(path)!);
  }

  const validatedCheckers = new Set<string>();
  for (const candidate of [...candidates.values()]
    .filter(({ kind }) => kind === "checker")
    .sort((left, right) => byteCompare(left.path, right.path))) {
    try {
      const module = projectRelative(projectRoot, candidate.path);
      await validateCheckerModule({ type: "checker", module } as CheckerAssertionSpec, projectRoot);
      validatedCheckers.add(candidate.path);
    } catch (cause) {
      recordError(cause, candidate.path);
    }
  }

  const validRubrics = new Set<string>();
  for (const state of [...states.values()]
    .filter(({ kind }) => kind === "rubric")
    .sort((left, right) => byteCompare(left.path, right.path))) {
    let valid = !state.hasDiagnostics;
    const calibration = asRecord(state.document?.["calibration"]);
    const setReference = calibration["set"];
    if (typeof setReference === "string") {
      let calibrationPath: string | undefined;
      if (isAbsolute(setReference) || !contained(projectRoot, resolve(dirname(state.path), setReference))) {
        recordError(validationError(
          "task_invalid",
          "task_invalid/rubric-calibration-path",
          `rubric calibration path escapes the project root: ${setReference}`,
          state.path,
          "$.calibration.set",
          "Use a relative calibration JSONL path inside the project root."
        ), state.path);
        valid = false;
      } else {
        try {
          calibrationPath = await realpath(resolve(dirname(state.path), setReference));
          if (!contained(projectRoot, calibrationPath) || !(await stat(calibrationPath)).isFile()) {
            throw new Error("calibration target is not an in-project regular file");
          }
        } catch (cause) {
          recordError(validationError(
            "task_invalid",
            "task_invalid/rubric-calibration-unavailable",
            `rubric calibration set is unavailable: ${setReference}`,
            state.path,
            "$.calibration.set",
            "Restore the checked-in calibration JSONL file or correct the path."
          ), state.path);
          valid = false;
        }
      }
      if (calibrationPath !== undefined) {
        try {
          const bytes = await readFile(calibrationPath);
          if (bytes.byteLength > MAX_CALIBRATION_BYTES) {
            throw new Error(`calibration file exceeds ${MAX_CALIBRATION_BYTES} bytes`);
          }
          const text = UTF8.decode(bytes);
          const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
          for (const [index, line] of lines.entries()) {
            try {
              const item = JSON.parse(line) as unknown;
              if (typeof item !== "object" || item === null || Array.isArray(item)) {
                throw new Error("item must be a JSON object");
              }
            } catch (cause) {
              recordError(validationError(
                "task_invalid",
                "task_invalid/rubric-calibration-jsonl",
                `rubric calibration item ${index + 1} is not a JSON object`,
                state.path,
                "$.calibration.set",
                "Make every non-empty calibration line one JSON object."
              ), state.path);
              valid = false;
            }
          }
          if (lines.length < 50) {
            recordError(validationError(
              "task_invalid",
              "task_invalid/rubric-calibration-size",
              `rubric calibration set contains ${lines.length} items; at least 50 are required`,
              state.path,
              "$.calibration.labeled_items",
              "Commit at least 50 human-labeled calibration items."
            ), state.path);
            valid = false;
          }
          const declared = calibration["labeled_items"];
          if (typeof declared === "number" && Number.isInteger(declared) && declared !== lines.length) {
            recordError(validationError(
              "task_invalid",
              "task_invalid/rubric-calibration-count",
              `rubric declares ${declared} labeled items but the JSONL contains ${lines.length}`,
              state.path,
              "$.calibration.labeled_items",
              "Set labeled_items to the exact number of non-empty JSONL records."
            ), state.path);
            valid = false;
          }
        } catch (cause) {
          if (cause instanceof AssayError) recordError(cause, state.path);
          else recordError(validationError(
            "task_invalid",
            "task_invalid/rubric-calibration-unreadable",
            `rubric calibration set could not be read as bounded UTF-8 JSONL: ${setReference}`,
            state.path,
            "$.calibration.set",
            "Save the bounded calibration set as UTF-8 JSONL."
          ), state.path);
          valid = false;
        }
      }
    }
    if (valid) validRubrics.add(state.path);
  }

  const taskState = (path: string): YamlState | undefined => states.get(resolve(path));
  const cachedLoadTask = async (path: string): Promise<LoadedYaml<TaskDocument>> => {
    const canonical = await realpath(resolve(path));
    const state = taskState(canonical);
    if (state?.kind === "task" && state.loaded !== undefined) {
      return state.loaded as LoadedYaml<TaskDocument>;
    }
    return await loadTask(canonical);
  };
  const cachedLoadMatrix = async (path: string): Promise<LoadedYaml<MatrixDocument>> => {
    const canonical = await realpath(resolve(path));
    const state = states.get(canonical);
    if (state?.kind === "matrix" && state.loaded !== undefined) {
      return state.loaded as LoadedYaml<MatrixDocument>;
    }
    return await loadMatrix(canonical);
  };

  const tasks = new Map<string, HashedResolvedTask>();
  for (const state of [...states.values()]
    .filter(({ kind }) => kind === "task")
    .sort((left, right) => byteCompare(left.path, right.path))) {
    if (state.loaded === undefined) continue;
    try {
      const resolvedTask = await resolveTaskInheritance(
        state.loaded as LoadedYaml<TaskDocument>,
        { projectRoot, loadTask: cachedLoadTask }
      );
      if (resolvedTask.document["abstract"] !== true) {
        const task = hashed(resolvedTask);
        tasks.set(taskKey(task), task);
      }
    } catch (cause) {
      recordError(cause, state.path);
    }
  }

  for (const state of [...states.values()]
    .filter(({ kind }) => kind === "matrix")
    .sort((left, right) => byteCompare(left.path, right.path))) {
    if (state.loaded === undefined) continue;
    try {
      const matrix = state.loaded as LoadedYaml<MatrixDocument>;
      const basePath = await realpath(resolve(dirname(state.path), matrix.document.task));
      const base = await resolveTaskInheritance(await cachedLoadTask(basePath), {
        projectRoot,
        loadTask: cachedLoadTask
      });
      for (const expanded of expandMatrix(matrix, base)) {
        const task = hashed(expanded);
        tasks.set(taskKey(task), task);
      }
    } catch (cause) {
      recordError(cause, state.path);
    }
  }

  const suites = new Map<string, ResolvedSuite>();
  for (const state of [...states.values()]
    .filter(({ kind }) => kind === "suite")
    .sort((left, right) => byteCompare(left.path, right.path))) {
    if (state.loaded === undefined) continue;
    const variants = asRecord(state.document?.["variants"]);
    const comparison = asRecord(state.document?.["comparison"]);
    const baseline = comparison["baseline_variant"];
    const candidate = comparison["candidate_variant"];
    if (typeof baseline === "string" && !Object.hasOwn(variants, baseline)) {
      recordError(validationError(
        "suite_invalid",
        "suite_invalid/comparison-baseline",
        `comparison baseline variant ${baseline} is not declared`,
        state.path,
        "$.comparison.baseline_variant",
        "Choose a declared variant as the comparison baseline."
      ), state.path);
    }
    if (typeof candidate === "string" && !Object.hasOwn(variants, candidate)) {
      recordError(validationError(
        "suite_invalid",
        "suite_invalid/comparison-candidate",
        `comparison candidate variant ${candidate} is not declared`,
        state.path,
        "$.comparison.candidate_variant",
        "Choose a declared variant as the comparison candidate."
      ), state.path);
    }
    if (typeof baseline === "string" && baseline === candidate) {
      recordError(validationError(
        "suite_invalid",
        "suite_invalid/comparison-distinct",
        "comparison baseline and candidate variants must be distinct",
        state.path,
        "$.comparison",
        "Choose two different declared variants."
      ), state.path);
    }
    try {
      const suite = await resolveSuite(state.loaded as LoadedYaml<SuiteDocument>, {
        projectRoot,
        loadTask: cachedLoadTask,
        loadMatrix: cachedLoadMatrix
      });
      suites.set(state.path, suite);
      for (const task of suite.tasks) tasks.set(taskKey(task), task);
    } catch (cause) {
      recordError(cause, state.path);
    }
  }

  for (const task of [...tasks.values()].sort((left, right) => byteCompare(taskKey(left), taskKey(right)))) {
    const assertions = Array.isArray(task.document["assertions"])
      ? task.document["assertions"]
      : [];
    const assertionOrigin = task.fieldOrigins["assertions"] ?? task.path;
    try {
      validateAssertionLayerOrder(assertions);
    } catch (cause) {
      const index = typeof cause === "object" && cause !== null && "assertionIndex" in cause &&
          typeof (cause as { readonly assertionIndex?: unknown }).assertionIndex === "number"
        ? (cause as { readonly assertionIndex: number }).assertionIndex
        : 0;
      recordError(cause, assertionOrigin, { yamlPath: `$.assertions[${index}]` });
    }
    try {
      await resolvePrompt(projectRoot, task);
    } catch (cause) {
      recordError(cause, task.fieldOrigins["prompt"] ?? task.path, { yamlPath: "$.prompt" });
    }
    try {
      await resolveFixture(projectRoot, task);
    } catch (cause) {
      recordError(cause, task.fieldOrigins["fixture"] ?? task.path, { yamlPath: "$.fixture" });
    }

    const taskJudge = asRecord(task.document["judge"]);
    for (const [index, value] of assertions.entries()) {
      const assertion = asRecord(value);
      const type = assertion["type"];
      const yamlPath = `$.assertions[${index}]`;
      if (type === "checker") {
        const module = assertion["module"];
        if (typeof module === "string") {
          await addRelativeReference(assertionOrigin, module, ["checker"], {
            filePath: assertionOrigin,
            yamlPath: `${yamlPath}.module`,
            category: "task_invalid"
          });
        }
        continue;
      }
      if (type === "judge") {
        const explicitRubric = assertion["rubric"];
        const fallbackRubric = taskJudge["rubric"];
        const rubric = typeof explicitRubric === "string"
          ? explicitRubric
          : typeof fallbackRubric === "string"
            ? fallbackRubric
            : undefined;
        if (rubric === undefined) {
          recordError(validationError(
            "task_invalid",
            "task_invalid/judge-rubric",
            "judge assertion has no assertion-level or task-level rubric",
            assertionOrigin,
            yamlPath,
            "Reference a checked-in *.rubric.yaml file."
          ), assertionOrigin);
        } else {
          const rubricOrigin = typeof explicitRubric === "string"
            ? assertionOrigin
            : task.fieldOrigins["judge"] ?? task.path;
          await addRelativeReference(rubricOrigin, rubric, ["rubric"], {
            filePath: rubricOrigin,
            yamlPath: typeof explicitRubric === "string" ? `${yamlPath}.rubric` : "$.judge.rubric",
            category: "task_invalid"
          });
        }
        if (assertion["advisory"] !== true) {
          recordError(validationError(
            "judge_uncalibrated",
            "judge_uncalibrated/agreement-record",
            "gating judge assertion has no accepted rubric-version × judge-model agreement record",
            assertionOrigin,
            yamlPath,
            "Mark the assertion advisory or calibrate it after the R7 judge gate is available."
          ), assertionOrigin);
        }
        continue;
      }
      if (type === "trajectory") continue;
      try {
        await normalizeAssertion(projectRoot, assertionOrigin, value);
      } catch (cause) {
        recordError(cause, assertionOrigin, { yamlPath });
      }
    }
  }

  if (findings.length > 0) {
    const unique = new Map<string, ValidationFinding>();
    for (const finding of findings) {
      const displayPath = contained(projectRoot, finding.filePath)
        ? projectRelative(projectRoot, finding.filePath)
        : finding.filePath;
      const normalized = { ...finding, filePath: displayPath };
      unique.set(
        `${normalized.filePath}\0${normalized.yamlPath}\0${normalized.code}\0${normalized.message}`,
        normalized
      );
    }
    const ordered = [...unique.values()].sort((left, right) => {
      const pathOrder = byteCompare(left.filePath, right.filePath);
      if (pathOrder !== 0) return pathOrder;
      const yamlOrder = byteCompare(left.yamlPath, right.yamlPath);
      if (yamlOrder !== 0) return yamlOrder;
      const codeOrder = byteCompare(left.code, right.code);
      return codeOrder !== 0 ? codeOrder : byteCompare(left.message, right.message);
    });
    const first = ordered[0]!;
    const category: AssayErrorCategory = exitCodeForCategory(first.category) === 4
      ? first.category
      : first.filePath.endsWith(".suite.yaml")
        ? "suite_invalid"
        : "task_invalid";
    throw new ValidationDiagnosticsError(category, ordered);
  }

  return {
    suites: suites.size,
    tasks: tasks.size,
    matrices: [...states.values()].filter(({ kind }) => kind === "matrix").length,
    checkers: validatedCheckers.size,
    rubrics: validRubrics.size
  };
}
