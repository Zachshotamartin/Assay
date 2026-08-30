import { readFile as readFileFromDisk } from "node:fs/promises";

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
  validateTaskDocument,
  type SchemaValidationFailure,
  type SchemaValidationResult
} from "./schema.js";

export const MAX_YAML_FILE_BYTES = 1_048_576;
const MAX_ALIAS_COUNT = 100;

type YamlKind = "task" | "suite" | "matrix";
type YamlCategory = Extract<AssayErrorCategory, "task_invalid" | "suite_invalid">;

export type TaskDocument = Readonly<Record<string, unknown>>;
export type SuiteDocument = Readonly<Record<string, unknown>>;
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

function positionForSchemaFailure(
  document: Document.Parsed<ParsedNode>,
  lineCounter: LineCounter,
  schemaFailure: SchemaValidationFailure
): { readonly line: number; readonly column: number; readonly yamlPath: string } {
  const first = schemaFailure.errors[0];
  const segments = jsonPointerSegments(first?.instancePath ?? "");
  const extraProperty = first?.keyword === "additionalProperties"
    ? first.params["additionalProperty"]
    : undefined;
  if (typeof extraProperty === "string") {
    segments.push(extraProperty);
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

function parseAndValidate(
  bytes: Uint8Array,
  filePath: string,
  kind: YamlKind
): LoadedYaml<Readonly<Record<string, unknown>>> {
  const parsed = parsePlainDocument(bytes, filePath, kind);
  const validation: SchemaValidationResult = kind === "task"
    ? validateTaskDocument(parsed.value)
    : kind === "suite"
      ? validateSuiteDocument(parsed.value)
      : validateMatrixDocument(parsed.value);

  if (!validation.ok) {
    const position = positionForSchemaFailure(
      parsed.document,
      parsed.lineCounter,
      validation
    );
    const versionFailure = validation.code.endsWith("/format-version-unsupported");
    throw failure(
      kind,
      filePath,
      versionFailure ? "format-version-unsupported" : "schema",
      versionFailure
        ? `${categoryFor(kind)}: unsupported format_version; supported version is 1.0`
        : `${categoryFor(kind)}: document does not match the published schema`,
      versionFailure
        ? "Set format_version to 1.0 or upgrade Assay to a version that supports the file."
        : "Change the value at the reported YAML path to match the published schema.",
      position
    );
  }

  return { path: filePath, source: parsed.source, document: parsed.value };
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
