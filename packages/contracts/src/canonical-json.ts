import { AssayError } from "./errors.js";

const encoder = new TextEncoder();

function reject(path: string, reason: string): never {
  throw new AssayError(
    "invalid_invocation",
    `invalid_invocation: canonical JSON rejected ${path}: ${reason}`
  );
}

function assertPairedSurrogates(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        reject(path, "unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(path, "unpaired low surrogate");
    }
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) as number);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) as number);
  const limit = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < limit; index += 1) {
    const delta = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (delta !== 0) {
      return delta;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function encodeString(value: string, path: string): string {
  assertPairedSurrogates(value, path);
  return JSON.stringify(value);
}

function encodeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return encodeString(value, path);
    case "number":
      if (!Number.isFinite(value)) {
        return reject(path, "number must be finite");
      }
      if (!Number.isInteger(value)) {
        return reject(path, "numbers must be integers");
      }
      if (!Number.isSafeInteger(value)) {
        return reject(path, "integer is outside the exactly representable signed range");
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return reject(path, `${typeof value} is not canonical JSON`);
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    return reject(path, "circular reference");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry, index) => encodeValue(entry, `${path}[${index}]`, ancestors))
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return reject(path, "only plain objects are canonical JSON objects");
    }

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    for (const key of keys) {
      assertPairedSurrogates(key, `${path} key`);
    }
    keys.sort(compareUnicodeCodePoints);

    return `{${keys
      .map(
        (key) =>
          `${encodeString(key, `${path} key`)}:${encodeValue(object[key], `${path}.${key}`, ancestors)}`
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encodeValue(value, "$", new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}
