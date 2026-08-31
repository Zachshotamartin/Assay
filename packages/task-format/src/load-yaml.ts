import { readFile as readFileFromDisk } from "node:fs/promises";
import { basename } from "node:path";

import { AssayError, type AssayErrorCategory } from "@assay/contracts";
import {
  LineCounter,
  isNode,
  parseDocument,
  type Document,
  type ParsedNode
} from "yaml";

import {
  validateSuiteDocument,
  validateMatrixDocument,
  validateRubricDocument,
  validateTaskDocument,
  type SchemaValidationFailure,
  type SchemaValidationResult
} from "./schema.js";

export const MAX_YAML_FILE_BYTES = 1_048_576;
const MAX_ALIAS_COUNT = 100;

export type YamlKind = "task" | "suite" | "matrix" | "rubric";
type YamlCategory = Extract<AssayErrorCategory, "task_invalid" | "suite_invalid">;

export type TaskDocument = Readonly<Record<string, unknown>>;
export type SuiteDocument = Readonly<Record<string, unknown>>;
export type RubricDocument = Readonly<Record<string, unknown>>;
export type MatrixScalar = string | number | boolean;
export type MatrixDocument = Readonly<Record<string, unknown>> & {
  readonly format_version: "1.0";
  readonly task: string;
  readonly axes: Readonly<Record<string, readonly MatrixScalar[]>>;
  readonly exclude?: readonly Readonly<Record<string, MatrixScalar>>[];
};

export interface LoadedYaml<TDocument extends Readonly<Record<string, unknown>>> {
  readonly path: string;
  readonly source: string;
  readonly document: TDocument;
  readonly warnings?: readonly TaskFormatWarning[];
}

export interface YamlInspection<TDocument extends Readonly<Record<string, unknown>>> {
  readonly source: string | undefined;
  readonly document: TDocument | undefined;
  readonly loaded: LoadedYaml<TDocument> | undefined;
  readonly diagnostics: readonly TaskFormatError[];
  readonly warnings: readonly TaskFormatWarning[];
}

export interface TaskFormatWarning {
  readonly code: "task_warning/id-file-name-mismatch";
  readonly filePath: string;
  readonly yamlPath: "$.id";
  readonly message: string;
  readonly remedy: string;
}

export interface TaskFormatDiagnostic {
  readonly category: YamlCategory;
  readonly code: string;
  readonly filePath: string;
  readonly yamlPath: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly remedy: string;
}

export class TaskFormatError extends AssayError implements TaskFormatDiagnostic {
  declare readonly category: YamlCategory;
  readonly code: string;
  readonly filePath: string;
  readonly yamlPath: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly remedy: string;

  constructor(
    diagnostic: TaskFormatDiagnostic,
    message: string,
    options: { readonly cause?: unknown } = {}
  ) {
    super(diagnostic.category, message, options);
    this.name = "TaskFormatError";
    this.code = diagnostic.code;
    this.filePath = diagnostic.filePath;
    this.yamlPath = diagnostic.yamlPath;
    this.line = diagnostic.line;
    this.column = diagnostic.column;
    this.remedy = diagnostic.remedy;
  }
}

export interface YamlLoaderIo {
  readonly readFile: (path: string) => Promise<Uint8Array>;
}

const DEFAULT_IO: YamlLoaderIo = {
  readFile: async (path) => readFileFromDisk(path)
};

function categoryFor(kind: YamlKind): YamlCategory {
  return kind === "suite" ? "suite_invalid" : "task_invalid";
}

function warningsFor(
  kind: YamlKind,
  filePath: string,
  document: Readonly<Record<string, unknown>>
): readonly TaskFormatWarning[] {
  if (kind !== "task" || !filePath.endsWith(".task.yaml")) return [];
  const id = document["id"];
  if (typeof id !== "string") return [];
  const fileName = basename(filePath);
  const fileStem = fileName.slice(0, -".task.yaml".length);
  if (fileStem === id) return [];
  return [{
    code: "task_warning/id-file-name-mismatch",
    filePath,
    yamlPath: "$.id",
    message: `task id ${id} differs from file basename ${fileStem}`,
    remedy: `Rename the task file to ${id}.task.yaml or change its id intentionally.`
  }];
}

function failure(
  kind: YamlKind,
  filePath: string,
  codeSuffix: string,
  message: string,
  remedy: string,
  position: { readonly line?: number; readonly column?: number; readonly yamlPath?: string } = {},
  cause?: unknown
): TaskFormatError {
  const category = categoryFor(kind);
  return new TaskFormatError(
    {
      category,
      code: `${category}/${codeSuffix}`,
      filePath,
      yamlPath: position.yamlPath ?? "$",
      line: position.line,
      column: position.column,
      remedy
    },
    message,
    cause === undefined ? {} : { cause }
  );
}

function decodeUtf8(bytes: Uint8Array, filePath: string, kind: YamlKind): string {
  if (bytes.byteLength > MAX_YAML_FILE_BYTES) {
    throw failure(
      kind,
      filePath,
      "file-too-large",
      `${categoryFor(kind)}: YAML file exceeds ${MAX_YAML_FILE_BYTES} bytes`,
      `Reduce the YAML file to at most ${MAX_YAML_FILE_BYTES} bytes.`
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw failure(
      kind,
      filePath,
      "utf8",
      `${categoryFor(kind)}: YAML file is not valid UTF-8`,
      "Save the file as valid UTF-8.",
      {},
      error
    );
  }
}

function jsonPointerSegments(pointer: string): string[] {
  if (pointer === "") {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function yamlPathFor(segments: readonly string[]): string {
  return segments.length === 0
    ? "$"
    : `$${segments.map((segment) => (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`)).join("")}`;
}

function positionForSchemaError(
  document: Document.Parsed<ParsedNode>,
  lineCounter: LineCounter,
  error: SchemaValidationFailure["errors"][number] | undefined,
  fallbackSegments: readonly string[] = []
): { readonly line: number; readonly column: number; readonly yamlPath: string } {
  const segments = error === undefined
    ? [...fallbackSegments]
    : jsonPointerSegments(error.instancePath);
  const extraProperty = error?.keyword === "additionalProperties"
    ? error.params["additionalProperty"]
    : undefined;
  if (typeof extraProperty === "string") {
    segments.push(extraProperty);
  }
  const missingProperty = error?.keyword === "required"
    ? error.params["missingProperty"]
    : undefined;
  if (typeof missingProperty === "string") {
    segments.push(missingProperty);
  }

  let node: unknown = document.contents;
  if (segments.length > 0) {
    node = document.getIn(segments, true);
  }
  const offset = isNode(node) && node.range != null ? node.range[0] : 0;
  const location = lineCounter.linePos(offset);
  return {
    line: location.line,
    column: location.col,
    yamlPath: yamlPathFor(segments)
  };
}

function positionForYamlPath(
  document: Document.Parsed<ParsedNode>,
  lineCounter: LineCounter,
  yamlPath: string
): { readonly line: number; readonly column: number; readonly yamlPath: string } {
  const segments: string[] = [];
  const matcher = /\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]|\[("(?:[^"\\]|\\.)*")\]/guy;
  matcher.lastIndex = 1;
  while (matcher.lastIndex < yamlPath.length) {
    const match = matcher.exec(yamlPath);
    if (match === null) break;
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(match[2]);
    else if (match[3] !== undefined) segments.push(JSON.parse(match[3]) as string);
  }
  let node: unknown = document.contents;
  let resolvedSegments = [...segments];
  while (resolvedSegments.length > 0) {
    node = document.getIn(resolvedSegments, true);
    if (isNode(node)) break;
    resolvedSegments = resolvedSegments.slice(0, -1);
  }
  const offset = isNode(node) && node.range != null ? node.range[0] : 0;
  const location = lineCounter.linePos(offset);
  return { line: location.line, column: location.col, yamlPath };
}

export function locateYamlPath(
  source: string,
  yamlPath: string
): { readonly line: number; readonly column: number } {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    schema: "core",
    strict: true,
    uniqueKeys: true
  });
  const position = positionForYamlPath(
    document as Document.Parsed<ParsedNode>,
    lineCounter,
    yamlPath
  );
  return { line: position.line, column: position.column };
}

function parsePlainDocument(
  bytes: Uint8Array,
  filePath: string,
  kind: YamlKind
): {
  readonly source: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly document: Document.Parsed<ParsedNode>;
  readonly lineCounter: LineCounter;
} {
  const source = decodeUtf8(bytes, filePath, kind);
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    schema: "core",
    strict: true,
    uniqueKeys: true
  });

  const parseProblem = document.errors[0] ?? document.warnings[0];
  if (parseProblem !== undefined) {
    const location = parseProblem.linePos?.[0] ?? { line: 1, col: 1 };
    throw failure(
      kind,
      filePath,
      "yaml-parse",
      `${categoryFor(kind)}: YAML parse failed at line ${location.line}, column ${location.col}`,
      "Fix the YAML syntax, remove duplicate keys, and use only YAML core-schema tags.",
      { line: location.line, column: location.col },
      parseProblem
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT, mapAsMap: false });
  } catch (error) {
    throw failure(
      kind,
      filePath,
      "yaml-parse",
      `${categoryFor(kind)}: YAML aliases exceed the safe expansion bound`,
      `Use no more than ${MAX_ALIAS_COUNT} aliases.`,
      { line: 1, column: 1 },
      error
    );
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure(
      kind,
      filePath,
      "schema",
      `${categoryFor(kind)}: YAML document must be a mapping`,
      "Make the document root a mapping of the published fields.",
      { line: 1, column: 1 }
    );
  }

  return {
    source,
    value: value as Readonly<Record<string, unknown>>,
    document,
    lineCounter
  };
}

function schemaValidationFor(
  value: unknown,
  kind: YamlKind
): SchemaValidationResult {
  return kind === "task"
    ? validateTaskDocument(value)
    : kind === "suite"
      ? validateSuiteDocument(value)
      : kind === "matrix"
        ? validateMatrixDocument(value)
        : validateRubricDocument(value);
}

function rubricRuleDiagnostics(
  parsed: ReturnType<typeof parsePlainDocument>,
  filePath: string
): readonly TaskFormatError[] {
  const criteria = parsed.value["criteria"];
  if (!Array.isArray(criteria)) return [];
  const diagnostics: TaskFormatError[] = [];
  const seen = new Map<string, number>();
  const weights: number[] = [];
  for (const [index, candidate] of criteria.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const criterion = candidate as Readonly<Record<string, unknown>>;
    const id = criterion["id"];
    if (typeof id === "string") {
      const prior = seen.get(id);
      if (prior !== undefined) {
        const yamlPath = `$.criteria[${index}].id`;
        diagnostics.push(failure(
          "rubric",
          filePath,
          "rubric-criteria-id-duplicate",
          `task_invalid: rubric criterion id ${JSON.stringify(id)} duplicates criteria[${prior}]`,
          "Give every rubric criterion a unique id.",
          positionForYamlPath(parsed.document, parsed.lineCounter, yamlPath)
        ));
      } else {
        seen.set(id, index);
      }
    }
    if (typeof criterion["weight"] === "number" && Number.isFinite(criterion["weight"])) {
      weights.push(criterion["weight"]);
    }
  }
  if (weights.length === criteria.length) {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(total - 1) > 1e-9) {
      const yamlPath = "$.criteria";
      diagnostics.push(failure(
        "rubric",
        filePath,
        "rubric-weight-sum",
        `task_invalid: rubric criterion weights sum to ${total}, not 1 within 1e-9`,
        "Adjust the positive criterion weights so they sum to exactly 1.",
        positionForYamlPath(parsed.document, parsed.lineCounter, yamlPath)
      ));
    }
  }
  return diagnostics;
}

function inspectAndValidate(
  bytes: Uint8Array,
  filePath: string,
  kind: YamlKind
): YamlInspection<Readonly<Record<string, unknown>>> {
  let parsed: ReturnType<typeof parsePlainDocument>;
  try {
    parsed = parsePlainDocument(bytes, filePath, kind);
  } catch (cause) {
    if (cause instanceof TaskFormatError) {
      return {
        source: undefined,
        document: undefined,
        loaded: undefined,
        diagnostics: [cause],
        warnings: []
      };
    }
    throw cause;
  }
  const validation = schemaValidationFor(parsed.value, kind);
  const diagnostics: TaskFormatError[] = [];
  if (!validation.ok) {
    const versionFailure = validation.code.endsWith("/format-version-unsupported");
    if (versionFailure) {
      diagnostics.push(failure(
        kind,
        filePath,
        "format-version-unsupported",
        `${categoryFor(kind)}: unsupported format_version; supported version is 1.0`,
        "Set format_version to 1.0 or upgrade Assay to a version that supports the file.",
        positionForSchemaError(parsed.document, parsed.lineCounter, undefined, ["format_version"])
      ));
    } else {
      for (const schemaError of validation.errors) {
        const rule = `${schemaError.keyword}${schemaError.message === undefined ? "" : ` ${schemaError.message}`}`;
        diagnostics.push(failure(
          kind,
          filePath,
          "schema",
          `${categoryFor(kind)}: document violates published schema rule ${rule}`,
          "Change the value at the reported YAML path to match the published schema.",
          positionForSchemaError(parsed.document, parsed.lineCounter, schemaError)
        ));
      }
    }
  }
  if (kind === "rubric") diagnostics.push(...rubricRuleDiagnostics(parsed, filePath));
  const warnings = diagnostics.length === 0 ? warningsFor(kind, filePath, parsed.value) : [];
  const loaded = diagnostics.length === 0
    ? { path: filePath, source: parsed.source, document: parsed.value, warnings }
    : undefined;
  return {
    source: parsed.source,
    document: parsed.value,
    loaded,
    diagnostics,
    warnings
  };
}

function parseAndValidate(
  bytes: Uint8Array,
  filePath: string,
  kind: YamlKind
): LoadedYaml<Readonly<Record<string, unknown>>> {
  const inspected = inspectAndValidate(bytes, filePath, kind);
  if (inspected.loaded !== undefined) return inspected.loaded;
  throw inspected.diagnostics[0] ?? failure(
    kind,
    filePath,
    "schema",
    `${categoryFor(kind)}: document could not be validated`,
    "Correct the document to match the published schema."
  );
}

export function inspectYamlBytes(
  bytes: Uint8Array,
  filePath: string,
  kind: YamlKind
): YamlInspection<Readonly<Record<string, unknown>>> {
  return inspectAndValidate(bytes, filePath, kind);
}

export function parseTaskBytes(
  bytes: Uint8Array,
  filePath: string
): LoadedYaml<TaskDocument> {
  return parseAndValidate(bytes, filePath, "task");
}

export function parseSuiteBytes(
  bytes: Uint8Array,
  filePath: string
): LoadedYaml<SuiteDocument> {
  return parseAndValidate(bytes, filePath, "suite");
}

export function parseMatrixBytes(
  bytes: Uint8Array,
  filePath: string
): LoadedYaml<MatrixDocument> {
  return parseAndValidate(bytes, filePath, "matrix") as LoadedYaml<MatrixDocument>;
}

export function parseRubricBytes(
  bytes: Uint8Array,
  filePath: string
): LoadedYaml<RubricDocument> {
  return parseAndValidate(bytes, filePath, "rubric");
}

export async function loadTask(
  filePath: string,
  io: YamlLoaderIo = DEFAULT_IO
): Promise<LoadedYaml<TaskDocument>> {
  return parseTaskBytes(await io.readFile(filePath), filePath);
}

export async function loadSuite(
  filePath: string,
  io: YamlLoaderIo = DEFAULT_IO
): Promise<LoadedYaml<SuiteDocument>> {
  return parseSuiteBytes(await io.readFile(filePath), filePath);
}

export async function loadMatrix(
  filePath: string,
  io: YamlLoaderIo = DEFAULT_IO
): Promise<LoadedYaml<MatrixDocument>> {
  return parseMatrixBytes(await io.readFile(filePath), filePath);
}

export async function loadRubric(
  filePath: string,
  io: YamlLoaderIo = DEFAULT_IO
): Promise<LoadedYaml<RubricDocument>> {
  return parseRubricBytes(await io.readFile(filePath), filePath);
}
