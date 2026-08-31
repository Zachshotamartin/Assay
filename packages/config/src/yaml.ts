import {
  isNode,
  LineCounter,
  parseDocument,
  type Document,
  type ParsedNode
} from "yaml";
import type { ErrorObject } from "ajv";

import {
  MAX_CONFIG_DEPTH,
  MAX_CONFIG_FILE_BYTES,
  MAX_CONFIG_ITEMS
} from "./constants.js";
import { configError } from "./errors.js";
import { ASSAY_CONFIG_LEAF_PATHS, type AssayConfigLeafPath, type ConfigFileInput, type ConfigValueSource } from "./types.js";
import { validateConfigDocument } from "./schema.js";
import type { ParsedConfigValues } from "./env.js";

const MAX_ALIAS_COUNT = 100;

function decode(input: ConfigFileInput): string {
  if (input.bytes.byteLength > MAX_CONFIG_FILE_BYTES) {
    throw configError("file-too-large", input.path, "$", `exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw configError("utf8", input.path, "$", "is not valid UTF-8");
  }
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((segment) =>
    segment.replace(/~1/gu, "/").replace(/~0/gu, "~")
  );
}

function keyForFailure(error: ErrorObject | undefined): string {
  if (error === undefined) return "$";
  const segments = pointerSegments(error.instancePath);
  if (error.keyword === "additionalProperties") {
    const additional = error.params["additionalProperty"];
    if (typeof additional === "string") segments.push(additional);
  } else if (error.keyword === "required") {
    const missing = error.params["missingProperty"];
    if (typeof missing === "string") segments.push(missing);
  }
  return segments.length === 0 ? "$" : segments.join(".");
}

function locate(
  document: Document.Parsed<ParsedNode>,
  lineCounter: LineCounter,
  key: string
): { readonly line: number; readonly column: number } {
  const segments = key === "$" ? [] : key.split(".");
  let node: unknown = document.contents;
  if (segments.length > 0) {
    const candidate = document.getIn(segments, true);
    if (candidate !== undefined) node = candidate;
  }
  const offset = isNode(node) && node.range !== null && node.range !== undefined
    ? node.range[0]
    : 0;
  const position = lineCounter.linePos(offset);
  return { line: position.line, column: position.col };
}

function enforceStructureBounds(value: unknown, source: string): void {
  let items = 0;
  const ancestors = new Set<object>();

  function visit(valueAtPath: unknown, depth: number): void {
    if (depth > MAX_CONFIG_DEPTH) {
      throw configError("depth-limit", source, "$", `exceeds the maximum depth of ${MAX_CONFIG_DEPTH}`);
    }
    if (typeof valueAtPath !== "object" || valueAtPath === null) return;
    if (ancestors.has(valueAtPath)) {
      throw configError("yaml-parse", source, "$", "contains a cyclic YAML alias");
    }

    ancestors.add(valueAtPath);
    try {
      if (Array.isArray(valueAtPath)) {
        for (const nested of valueAtPath) {
          items += 1;
          if (items > MAX_CONFIG_ITEMS) {
            throw configError("item-limit", source, "$", `exceeds the maximum item count of ${MAX_CONFIG_ITEMS}`);
          }
          visit(nested, depth + 1);
        }
      } else {
        for (const nested of Object.values(valueAtPath as Readonly<Record<string, unknown>>)) {
          items += 1;
          if (items > MAX_CONFIG_ITEMS) {
            throw configError("item-limit", source, "$", `exceeds the maximum item count of ${MAX_CONFIG_ITEMS}`);
          }
          visit(nested, depth + 1);
        }
      }
    } finally {
      ancestors.delete(valueAtPath);
    }
  }

  visit(value, 0);
}

function ownLeafValue(
  document: Readonly<Record<string, unknown>>,
  path: AssayConfigLeafPath
): { readonly present: boolean; readonly value: unknown } {
  const segments = path.split(".");
  let current: unknown = document;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current) ||
        !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined };
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return { present: true, value: current };
}

export function parseConfigFile(input: ConfigFileInput): ParsedConfigValues {
  const sourceText = decode(input);
  const lineCounter = new LineCounter();
  const document = parseDocument(sourceText, {
    lineCounter,
    schema: "core",
    strict: true,
    uniqueKeys: true
  });

  const parseProblem = document.errors[0] ?? document.warnings[0];
  if (parseProblem !== undefined) {
    const position = parseProblem.linePos?.[0] ?? { line: 1, col: 1 };
    throw configError(
      "yaml-parse",
      input.path,
      "$",
      "contains invalid YAML syntax",
      { line: position.line, column: position.col }
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT, mapAsMap: false });
  } catch {
    throw configError("yaml-parse", input.path, "$", "exceeds the safe YAML alias bound");
  }
  enforceStructureBounds(value, input.path);

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const version = (value as Readonly<Record<string, unknown>>)["configVersion"];
    if (typeof version === "number" && Number.isInteger(version) && version !== 1) {
      const position = locate(document, lineCounter, "configVersion");
      throw configError(
        "version-unsupported",
        input.path,
        "configVersion",
        "is unsupported; supported version is 1",
        position
      );
    }
  }

  const schemaResult = validateConfigDocument(value);
  if (!schemaResult.ok) {
    const first = schemaResult.errors[0];
    const key = keyForFailure(first);
    const position = locate(document, lineCounter, key);
    throw configError("file-schema", input.path, key, "does not satisfy the configuration schema", position);
  }

  const record = value as Readonly<Record<string, unknown>>;
  const values: Partial<Record<AssayConfigLeafPath, unknown>> = {};
  const sources: Partial<Record<AssayConfigLeafPath, ConfigValueSource>> = {};
  for (const path of ASSAY_CONFIG_LEAF_PATHS) {
    const leaf = ownLeafValue(record, path);
    if (!leaf.present) continue;
    const position = locate(document, lineCounter, path);
    values[path] = leaf.value;
    sources[path] = Object.freeze({
      kind: "file",
      source: input.path,
      key: path,
      line: position.line,
      column: position.column
    });
  }
  return { values: Object.freeze(values), sources: Object.freeze(sources) };
}
