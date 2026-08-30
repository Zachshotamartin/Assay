import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  validateAssertionLayerOrder,
  validateCheckerModule,
  validateDeterministicAssertion,
  validateDiffMatchesAssertion,
  validateJsonSchemaAssertion,
  type CheckerAssertionSpec,
  type DeterministicAssertionSpec
} from "@assay/assertions";
import {
  environmentFromRecord,
  resolveAssayConfig,
  type AssayConfigOverrides,
  type ConfigFileInput,
  type ResolvedConfig
} from "@assay/config";
import {
  AssayError,
  exitCodeForCategory,
  type AssayErrorCategory
} from "@assay/contracts";
import {
  expandMatrix,
  loadMatrix,
  loadSuite,
  loadTask,
  resolveSuite,
  resolveTaskInheritance,
  taskContentHash,
  type HashedResolvedTask,
  type LoadedYaml,
  type ResolvedSuite,
  type ResolvedTask,
  type SuiteDocument,
  type TaskDocument
} from "@assay/task-format";

import type { CliRuntime } from "./runtime.js";

const DISCOVERY_EXCLUSIONS = new Set([".assay", ".git", "node_modules"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type PreparedAssertion = DeterministicAssertionSpec | CheckerAssertionSpec;

export type PreparedFixture =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly gitInit: boolean;
    }
  | {
      readonly kind: "archive";
      readonly path: string;
      readonly sha256: string;
      readonly gitInit: boolean;
    };

export interface PreparedTask {
  readonly source: HashedResolvedTask;
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly fixture: PreparedFixture;
  readonly assertions: readonly PreparedAssertion[];
  readonly networkAllowlist: boolean;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PreparedSuite {
  readonly source: ResolvedSuite;
  readonly tasks: readonly PreparedTask[];
}

export interface ValidationSummary {
  readonly suites: number;
  readonly tasks: number;
  readonly checkers: number;
}

export interface LoadedConfigInput {
  readonly file: ConfigFileInput | null;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function invalidPath(category: "invalid_invocation" | "task_invalid" | "suite_invalid", detail: string): never {
  throw new AssayError(
    category,
    `${category}: ${detail}; no run or provider activity occurred; use a path inside the project root`
  );
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(projectRoot));
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory()) return invalidPath("invalid_invocation", "project root is not a directory");
    return canonical;
  } catch (cause) {
    if (cause instanceof AssayError) throw cause;
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: project root ${JSON.stringify(projectRoot)} is unavailable; nothing ran; choose an existing project directory`,
      { cause }
    );
  }
}

async function canonicalInputPath(
  projectRoot: string,
  input: string,
  category: "invalid_invocation" | "task_invalid" | "suite_invalid" = "invalid_invocation"
): Promise<string> {
  const lexical = resolve(projectRoot, input);
  if (!contained(projectRoot, lexical)) {
    return invalidPath(category, `path escapes the project root: ${input}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch (cause) {
    throw new AssayError(
      category,
      `${category}: path is unavailable: ${input}; nothing ran; correct the referenced path`,
      { cause }
    );
  }
  if (!contained(projectRoot, canonical)) {
    return invalidPath(category, `path resolves outside the project root: ${input}`);
  }
  return canonical;
}

function projectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

async function referenceFromOrigin(
  projectRoot: string,
  origin: string,
  reference: string,
  category: "task_invalid" | "fixture_unavailable"
): Promise<string> {
  if (isAbsolute(reference)) {
    return invalidPath(category === "fixture_unavailable" ? "task_invalid" : category, `reference must be relative: ${reference}`);
  }
  const lexical = resolve(dirname(origin), reference);
  if (!contained(projectRoot, lexical)) {
    return invalidPath(category === "fixture_unavailable" ? "task_invalid" : category, `reference escapes the project root: ${reference}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch (cause) {
    throw new AssayError(
      category,
      `${category}: referenced path is unavailable: ${reference}; nothing ran; restore or correct the local reference`,
      { cause }
    );
  }
  if (!contained(projectRoot, canonical)) {
    return invalidPath(category === "fixture_unavailable" ? "task_invalid" : category, `reference resolves outside the project root: ${reference}`);
  }
  return canonical;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveStream);
  });
  return digest.digest("hex");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

async function resolveFixture(
  projectRoot: string,
  task: HashedResolvedTask
): Promise<PreparedFixture> {
  const fixture = asRecord(task.document["fixture"]);
  const origin = task.fieldOrigins["fixture"] ?? task.path;
  const gitInit = fixture["git_init"] === true;
  if (typeof fixture["path"] === "string") {
    const path = await referenceFromOrigin(projectRoot, origin, fixture["path"], "fixture_unavailable");
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
      throw new AssayError(
        "fixture_unavailable",
        `fixture_unavailable: fixture path is not a directory: ${fixture["path"]}; nothing ran; select a local directory fixture`
      );
    }
    return { kind: "directory", path, gitInit };
  }

  const archive = asRecord(fixture["archive"]);
  if (typeof archive["ref"] !== "string" || typeof archive["sha256"] !== "string") {
    throw new AssayError(
      "task_invalid",
      "task_invalid: fixture must declare exactly one path or archive reference; nothing ran; correct the task fixture"
    );
  }
  const path = await referenceFromOrigin(projectRoot, origin, archive["ref"], "fixture_unavailable");
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new AssayError(
      "fixture_unavailable",
      `fixture_unavailable: archive reference is not a regular file: ${archive["ref"]}; nothing ran; select a local archive file`
    );
  }
  const actual = await sha256File(path);
  if (actual !== archive["sha256"]) {
    throw new AssayError(
      "fixture_hash_mismatch",
      `fixture_hash_mismatch: expected ${archive["sha256"]} but found ${actual}; nothing ran; restore the pinned archive bytes or update the reviewed hash`
    );
  }
  return { kind: "archive", path, sha256: actual, gitInit };
}

async function resolvePrompt(projectRoot: string, task: HashedResolvedTask): Promise<string> {
  const prompt = task.document["prompt"];
  if (typeof prompt === "string") return prompt;
  const file = asRecord(prompt)["file"];
  if (typeof file !== "string") {
    throw new AssayError("task_invalid", "task_invalid: task prompt is not a string or file reference");
  }
  const origin = task.fieldOrigins["prompt"] ?? task.path;
  const path = await referenceFromOrigin(projectRoot, origin, file, "task_invalid");
  let decoded: string;
  try {
    decoded = UTF8.decode(await readFile(path));
  } catch (cause) {
    throw new AssayError(
      "task_invalid",
      `task_invalid: prompt file is not valid UTF-8: ${file}; nothing ran; save the prompt as UTF-8`,
      { cause }
    );
  }
  if (decoded.length === 0) {
    throw new AssayError("task_invalid", `task_invalid: prompt file is empty: ${file}; nothing ran; add a prompt`);
  }
  return decoded;
}

async function normalizeAssertion(
  projectRoot: string,
  origin: string,
  assertion: unknown
): Promise<PreparedAssertion> {
  const record = asRecord(assertion);
  const type = record["type"];
  if (type === "trajectory" || type === "judge") {
    throw new AssayError(
      "task_invalid",
      `task_invalid: ${type} assertions are not executable in R1; nothing ran; use deterministic/checker assertions until their owning gate is accepted`
    );
  }
  if (type === "checker") {
    const module = record["module"];
    if (typeof module !== "string") {
      throw new AssayError("checker_invalid", "checker_invalid: checker module path is missing");
    }
    const absolute = await referenceFromOrigin(projectRoot, origin, module, "task_invalid");
    const spec = { ...record, module: projectRelative(projectRoot, absolute) } as unknown as CheckerAssertionSpec;
    await validateCheckerModule(spec, projectRoot);
    return spec;
  }

  const normalized: Record<string, unknown> = { ...record };
  if (type === "json_schema" && typeof record["schema"] === "string") {
    const absolute = await referenceFromOrigin(projectRoot, origin, record["schema"], "task_invalid");
    normalized["schema"] = projectRelative(projectRoot, absolute);
  }
  if (type === "diff_matches" && typeof record["expected"] === "string") {
    const absolute = await referenceFromOrigin(projectRoot, origin, record["expected"], "task_invalid");
    normalized["expected"] = projectRelative(projectRoot, absolute);
  }
  validateDeterministicAssertion(normalized);
  const spec = normalized as unknown as DeterministicAssertionSpec;
  if (spec.type === "json_schema") await validateJsonSchemaAssertion(spec, projectRoot);
  if (spec.type === "diff_matches") await validateDiffMatchesAssertion(spec, projectRoot);
  return spec;
}

export async function prepareTask(
  projectRootInput: string,
  task: HashedResolvedTask
): Promise<PreparedTask> {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const assertions = Array.isArray(task.document["assertions"])
    ? task.document["assertions"]
    : [];
  validateAssertionLayerOrder(assertions);
  const origin = task.fieldOrigins["assertions"] ?? task.path;
  const normalized: PreparedAssertion[] = [];
  for (const assertion of assertions) {
    normalized.push(await normalizeAssertion(projectRoot, origin, assertion));
  }
  const sandbox = asRecord(task.document["sandbox"]);
  const env = asRecord(sandbox["env"]);
  const environment = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return {
    source: task,
    id: String(task.document["id"]),
    title: String(task.document["title"]),
    prompt: await resolvePrompt(projectRoot, task),
    fixture: await resolveFixture(projectRoot, task),
    assertions: normalized,
    networkAllowlist: sandbox["network"] === "allowlist",
    timeoutMs: typeof sandbox["timeout_ms"] === "number" ? sandbox["timeout_ms"] : 600_000,
    environment: Object.freeze(environment)
  };
}

function validateSuiteRelations(suite: ResolvedSuite): void {
  const variants = asRecord(suite.suite.document["variants"]);
  const comparison = asRecord(suite.suite.document["comparison"]);
  const baseline = comparison["baseline_variant"];
  const candidate = comparison["candidate_variant"];
  if (typeof baseline === "string" && !Object.hasOwn(variants, baseline)) {
    throw new AssayError("suite_invalid", `suite_invalid: comparison baseline variant ${baseline} is not declared`);
  }
  if (typeof candidate === "string" && !Object.hasOwn(variants, candidate)) {
    throw new AssayError("suite_invalid", `suite_invalid: comparison candidate variant ${candidate} is not declared`);
  }
  if (typeof baseline === "string" && baseline === candidate) {
    throw new AssayError("suite_invalid", "suite_invalid: comparison variants must be distinct");
  }
}

export async function loadPreparedSuite(
  projectRootInput: string,
  suiteInput: string
): Promise<PreparedSuite> {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const suitePath = await canonicalInputPath(projectRoot, suiteInput);
  if (!suitePath.endsWith(".suite.yaml")) {
    return invalidPath("invalid_invocation", `assay run requires a *.suite.yaml file: ${suiteInput}`);
  }
  const source = await resolveSuite(await loadSuite(suitePath), { projectRoot });
  validateSuiteRelations(source);
  const tasks: PreparedTask[] = [];
  for (const task of source.tasks) {
    tasks.push(await prepareTask(projectRoot, task));
  }
  return { source, tasks };
}

export async function loadConfigInput(projectRootInput: string): Promise<LoadedConfigInput> {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const path = resolve(projectRoot, "assay.config.yaml");
  try {
    return { file: { path, bytes: await readFile(path) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: null };
    throw new AssayError(
      "invalid_configuration",
      "invalid_configuration: assay.config.yaml could not be read; nothing ran; fix its permissions",
      { cause: error }
    );
  }
}

export function resolveRuntimeConfig(
  runtime: CliRuntime,
  input: LoadedConfigInput,
  cli: AssayConfigOverrides = {},
  context: {
    readonly unsafeHostExec?: boolean;
    readonly taskNetworkAllowlist?: boolean;
    readonly declaredDollarBudget?: boolean;
  } = {}
): ResolvedConfig {
  return resolveAssayConfig({
    cli,
    env: environmentFromRecord(runtime.environment),
    file: input.file,
    context
  });
}

async function walkValidationFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isDirectory() && DISCOVERY_EXCLUSIONS.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".task.yaml") ||
          entry.name.endsWith(".suite.yaml") ||
          entry.name.endsWith(".matrix.yaml"))
      ) {
        paths.push(path);
      }
    }
  };
  await visit(root);
  return paths;
}

async function validationInputs(projectRoot: string, inputs: readonly string[]): Promise<readonly string[]> {
  const requested = inputs.length === 0 ? [projectRoot] : inputs;
  const paths = new Set<string>();
  for (const input of requested) {
    if (input.includes("*")) {
      throw new AssayError(
        "invalid_invocation",
        `invalid_invocation: validate glob expansion is not available through a directory argument: ${input}; nothing ran; pass the containing directory`
      );
    }
    const path = await canonicalInputPath(projectRoot, input);
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const child of await walkValidationFiles(path)) paths.add(child);
    } else if (metadata.isFile()) {
      paths.add(path);
    } else {
      return invalidPath("invalid_invocation", `validation input is not a regular file or directory: ${input}`);
    }
  }
  return [...paths].sort();
}

function hashed(task: ResolvedTask): HashedResolvedTask {
  return { ...task, contentHash: taskContentHash(task.document) };
}

export async function validateProjectInputs(
  runtime: CliRuntime,
  inputs: readonly string[]
): Promise<ValidationSummary> {
  const projectRoot = await canonicalProjectRoot(runtime.projectRoot);
  const paths = await validationInputs(projectRoot, inputs);
  if (paths.length === 0) {
    throw new AssayError(
      "invalid_invocation",
      "invalid_invocation: validation discovered no task, suite, or matrix files; nothing ran; pass a populated project path"
    );
  }

  const findings: Array<{
    readonly category: AssayErrorCategory;
    readonly filePath: string;
    readonly yamlPath: string;
    readonly code: string;
    readonly message: string;
  }> = [];
  const recordFinding = (error: unknown, fallbackPath: string): void => {
    const classified = error instanceof AssayError
      ? error
      : new AssayError("internal_invariant", "internal_invariant: validation subsystem threw an unclassified error");
    const detailed = classified as AssayError & {
      readonly filePath?: string;
      readonly yamlPath?: string;
      readonly code?: string;
    };
    const sourcePath = detailed.filePath ?? fallbackPath;
    const absoluteSource = resolve(sourcePath);
    const displayPath = contained(projectRoot, absoluteSource)
      ? projectRelative(projectRoot, absoluteSource)
      : sourcePath;
    findings.push({
      category: classified.category,
      filePath: displayPath,
      yamlPath: detailed.yamlPath ?? "$",
      code: detailed.code ?? classified.category,
      message: classified.message
    });
  };

  const suites = new Map<string, ResolvedSuite>();
  const tasks = new Map<string, HashedResolvedTask>();
  for (const path of paths) {
    try {
      if (path.endsWith(".suite.yaml")) {
        const suite = await resolveSuite(await loadSuite(path), { projectRoot });
        validateSuiteRelations(suite);
        suites.set(path, suite);
        for (const task of suite.tasks) tasks.set(task.path + String(task.document["id"]), task);
        continue;
      }
      if (path.endsWith(".task.yaml")) {
        const task = await resolveTaskInheritance(await loadTask(path), { projectRoot });
        if (task.document["abstract"] !== true) tasks.set(task.path + String(task.document["id"]), hashed(task));
        continue;
      }
      if (path.endsWith(".matrix.yaml")) {
        const matrix = await loadMatrix(path);
        const basePath = await canonicalInputPath(projectRoot, resolve(dirname(path), matrix.document.task), "task_invalid");
        const base = await resolveTaskInheritance(await loadTask(basePath), { projectRoot });
        for (const task of expandMatrix(matrix, base)) {
          const prepared = hashed(task);
          tasks.set(prepared.path + String(prepared.document["id"]), prepared);
        }
        continue;
      }
      invalidPath("invalid_invocation", `unknown validation file kind: ${path}`);
    } catch (error) {
      recordFinding(error, path);
    }
  }

  let checkerCount = 0;
  for (const task of [...tasks.values()].sort((left, right) => {
    const leftKey = `${left.path}\0${String(left.document["id"])}`;
    const rightKey = `${right.path}\0${String(right.document["id"])}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    try {
      const prepared = await prepareTask(projectRoot, task);
      checkerCount += prepared.assertions.filter((assertion) => assertion.type === "checker").length;
    } catch (error) {
      recordFinding(error, task.path);
    }
  }

  if (findings.length > 0) {
    const unique = new Map<string, (typeof findings)[number]>();
    for (const finding of findings) {
      unique.set(
        `${finding.filePath}\0${finding.yamlPath}\0${finding.code}\0${finding.message}`,
        finding
      );
    }
    const ordered = [...unique.values()].sort((left, right) => {
      const leftKey = `${left.filePath}\0${left.yamlPath}\0${left.code}`;
      const rightKey = `${right.filePath}\0${right.yamlPath}\0${right.code}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const firstCategory = ordered[0]!.category;
    const category: AssayErrorCategory = exitCodeForCategory(firstCategory) === 4
      ? firstCategory
      : ordered[0]!.filePath.endsWith(".suite.yaml")
        ? "suite_invalid"
        : "task_invalid";
    throw new AssayError(
      category,
      `${category}: validation found ${ordered.length} diagnostic${ordered.length === 1 ? "" : "s"}; nothing ran:\n` +
      ordered.map((finding) =>
        `${finding.filePath} ${finding.yamlPath} ${finding.code}: ${finding.message}`).join("\n")
    );
  }

  return { suites: suites.size, tasks: tasks.size, checkers: checkerCount };
}

export function variantDefinition(
  suite: PreparedSuite,
  variant: string
): Readonly<Record<string, unknown>> {
  const variants = asRecord(suite.source.suite.document["variants"]);
  const selected = variants[variant];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: variant ${JSON.stringify(variant)} is not declared by suite ${String(suite.source.suite.document["id"])}; nothing ran; choose a declared variant`
    );
  }
  return selected as Readonly<Record<string, unknown>>;
}

export function taskRunPolicy(task: PreparedTask): Readonly<Record<string, unknown>> {
  return asRecord(task.source.document["run_policy"]);
}

export function suiteRunPolicy(suite: PreparedSuite): Readonly<Record<string, unknown>> {
  return asRecord(suite.source.suite.document["run_policy"]);
}

export function taskTags(task: PreparedTask): readonly string[] {
  return stringArray(task.source.document["tags"]);
}

function declaresDollarBudget(value: unknown): boolean {
  return Object.hasOwn(asRecord(value), "dollars");
}

export function suiteDeclaresDollarBudget(suite: PreparedSuite): boolean {
  return declaresDollarBudget(suite.source.suite.document["budgets"]) ||
    suite.tasks.some((task) => declaresDollarBudget(task.source.document["budgets"]));
}

export function suiteDeclaresAnyBudget(suite: PreparedSuite): boolean {
  return suite.source.suite.document["budgets"] !== undefined ||
    suite.source.suite.document["spend_ceiling_dollars"] !== undefined ||
    suite.tasks.some((task) => task.source.document["budgets"] !== undefined);
}
