import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "@assay/contracts";

import { TaskFormatError } from "./load-yaml.js";

export type TaggedHashTree =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: string }
  | { readonly type: "array"; readonly value: readonly TaggedHashTree[] }
  | {
      readonly type: "object";
      readonly value: Readonly<Record<string, TaggedHashTree>>;
    };

function unsupportedHashValue(path: string, detail: string): TaskFormatError {
  return new TaskFormatError(
    {
      category: "task_invalid",
      code: "task_invalid/content-hash",
      filePath: "<resolved-task>",
      yamlPath: path,
      line: undefined,
      column: undefined,
      remedy: "Use only schema-valid YAML core values in resolved tasks."
    },
    `task_invalid: resolved task cannot be content-hashed at ${path}: ${detail}`
  );
}

function tagValue(
  value: unknown,
  path: string,
  ancestors: Set<object>
): TaggedHashTree {
  if (value === null) {
    return { type: "null" };
  }
  if (typeof value === "boolean") {
    return { type: "boolean", value };
  }
  if (typeof value === "string") {
    return { type: "string", value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unsupportedHashValue(path, "number must be finite");
    }
    return { type: "number", value: Object.is(value, -0) ? "0" : String(value) };
  }
  if (typeof value !== "object") {
    throw unsupportedHashValue(path, `${typeof value} is not a YAML core value`);
  }
  if (ancestors.has(value)) {
    throw unsupportedHashValue(path, "circular value");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return {
        type: "array",
        value: value.map((entry, index) => tagValue(entry, `${path}[${index}]`, ancestors))
      };
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupportedHashValue(path, "object must have a plain prototype");
    }
    const tagged: Record<string, TaggedHashTree> = {};
    for (const [key, nested] of Object.entries(value)) {
      tagged[key] = tagValue(nested, `${path}.${key}`, ancestors);
    }
    return { type: "object", value: tagged };
  } finally {
    ancestors.delete(value);
  }
}

export function toTaggedHashTree(value: unknown): TaggedHashTree {
  return tagValue(value, "$", new Set<object>());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function taskContentHash(document: unknown): string {
  return sha256(canonicalJsonBytes(toTaggedHashTree(document)));
}

export function suiteContentHash(orderedTaskHashes: readonly string[]): string {
  return sha256(canonicalJsonBytes(orderedTaskHashes));
}
