import { failClosed, failRedaction } from "./error.js";
import {
  mergeManifests,
  normalizeOptions,
  redactionOptionsFromNormalized,
  redactText,
  redactTextWithContext
} from "./text.js";
import type {
  JsonValue,
  RedactionManifest,
  RedactionOptions,
  RedactionResult
} from "./types.js";

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

export function childLocation(parent: string, segment: string): string {
  return `${parent}/${escapeJsonPointerSegment(segment)}`;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    failRedaction("JSON traversal");
  }
  if (ancestors.has(value)) {
    failRedaction("JSON traversal");
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key))
      )
    ) {
      failRedaction("JSON traversal");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        failRedaction("JSON traversal");
      }
      assertJsonValue(value[index], ancestors);
    }
    ancestors.delete(value);
    return;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failRedaction("JSON traversal");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      failRedaction("JSON traversal");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      failRedaction("JSON traversal");
    }
    assertJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

export function validateJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValue(value, new Set<object>());
}

function boundedAdd(total: number, amount: number, maximum: number): number {
  if (total > maximum || amount > maximum - total) {
    return maximum + 1;
  }
  return total + amount;
}

function jsonStringByteLength(value: string, maximum: number): number {
  let total = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let width: number;
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x0c ||
      codeUnit === 0x0a ||
      codeUnit === 0x0d ||
      codeUnit === 0x09
    ) {
      width = 2;
    } else if (codeUnit <= 0x1f) {
      width = 6;
    } else if (codeUnit <= 0x7f) {
      width = 1;
    } else if (codeUnit <= 0x7ff) {
      width = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        failRedaction("JSON traversal");
      }
      width = 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      failRedaction("JSON traversal");
    } else {
      width = 3;
    }
    total = boundedAdd(total, width, maximum);
    if (total > maximum) {
      return total;
    }
  }
  return total;
}

/** Exact UTF-8 byte length of JSON serialization, capped at maximum + 1. */
export function jsonUtf8ByteLength(value: JsonValue, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    failRedaction("JSON traversal");
  }
  if (typeof value === "string") {
    return jsonStringByteLength(value, maximum);
  }
  if (value === null) {
    return Math.min(4, maximum + 1);
  }
  if (typeof value === "boolean") {
    return Math.min(value ? 4 : 5, maximum + 1);
  }
  if (typeof value === "number") {
    return Math.min(String(Object.is(value, -0) ? 0 : value).length, maximum + 1);
  }

  let total = 2;
  let first = true;
  if (Array.isArray(value)) {
    for (const child of value) {
      if (!first) {
        total = boundedAdd(total, 1, maximum);
      }
      first = false;
      total = boundedAdd(total, jsonUtf8ByteLength(child, maximum), maximum);
      if (total > maximum) {
        return total;
      }
    }
    return total;
  }

  for (const [key, child] of Object.entries(value)) {
    if (!first) {
      total = boundedAdd(total, 1, maximum);
    }
    first = false;
    total = boundedAdd(total, jsonStringByteLength(key, maximum), maximum);
    total = boundedAdd(total, 1, maximum);
    total = boundedAdd(total, jsonUtf8ByteLength(child, maximum), maximum);
    if (total > maximum) {
      return total;
    }
  }
  return total;
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => cloneJsonValue(child));
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: cloneJsonValue(child),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

interface RedactedNode {
  readonly value: JsonValue;
  readonly manifests: readonly RedactionManifest[];
}

function redactNode(
  value: JsonValue,
  options: RedactionOptions,
  location: string,
  contextKey?: string | undefined
): RedactedNode {
  if (typeof value === "string") {
    const result = contextKey === undefined
      ? redactText(value, { ...options, location })
      : redactTextWithContext(value, contextKey, { ...options, location });
    return { value: result.value, manifests: [result.manifest] };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { value, manifests: [] };
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    const manifests: RedactionManifest[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = redactNode(
        value[index]!,
        options,
        childLocation(location, String(index)),
        contextKey
      );
      output.push(child.value);
      manifests.push(...child.manifests);
    }
    return { value: output, manifests };
  }

  const output: Record<string, JsonValue> = {};
  const manifests: RedactionManifest[] = [];
  for (const [key, childValue] of Object.entries(value)) {
    // Object member names are captured text too. Their manifest points to the
    // containing object because RFC 6901 has no separate key location.
    const redactedKey = redactText(key, { ...options, location });
    if (Object.hasOwn(output, redactedKey.value)) {
      failRedaction("JSON traversal");
    }
    const child = redactNode(
      childValue,
      options,
      childLocation(location, redactedKey.value),
      key
    );
    Object.defineProperty(output, redactedKey.value, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    if (redactedKey.manifest.redactionCount > 0) {
      manifests.push(redactedKey.manifest);
    }
    manifests.push(...child.manifests);
  }
  return { value: output, manifests };
}

export function redactJsonDeep(
  value: unknown,
  options: RedactionOptions = {}
): RedactionResult<JsonValue> {
  return failClosed("JSON traversal", () => {
    const normalized = normalizeOptions(options);
    validateJsonValue(value);
    if (jsonUtf8ByteLength(value, normalized.maxInputBytes) > normalized.maxInputBytes) {
      failRedaction("JSON traversal");
    }

    const stableOptions = redactionOptionsFromNormalized(normalized);
    const node = redactNode(value, stableOptions, normalized.location);
    return {
      value: node.value,
      manifest: mergeManifests(node.manifests)
    };
  });
}
