import { failClosed, failRedaction } from "./error.js";
import { findEntropyMatches } from "./entropy.js";
import { findPatternMatches } from "./patterns.js";
import {
  DEFAULT_MAX_REDACTION_INPUT_BYTES,
  REDACTION_RULESET_VERSION,
  type InternalMatch,
  type RedactionManifest,
  type RedactionManifestEntry,
  type RedactionOptions,
  type RedactionResult
} from "./types.js";

export interface NormalizedOptions {
  readonly location: string;
  readonly knownHashes: ReadonlySet<string>;
  readonly maxInputBytes: number;
  readonly stageHook: RedactionOptions["stageHook"];
}

function isJsonPointer(value: string): boolean {
  return value === "" || (value.startsWith("/") && !/~(?![01])/u.test(value));
}

function jsonPointerSegments(value: string): readonly string[] {
  if (value === "") {
    return [];
  }
  return value
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function snapshotKnownHashes(source: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (source === undefined) {
    return new Set<string>();
  }
  if (!(source instanceof Set)) {
    failRedaction("text validation");
  }

  const snapshot = new Set<string>();
  const nativeIterator = Set.prototype.values.call(source) as SetIterator<unknown>;
  for (const candidate of nativeIterator) {
    if (typeof candidate !== "string") {
      failRedaction("text validation");
    }
    snapshot.add(candidate);
  }
  return snapshot;
}

export function normalizeOptions(options: RedactionOptions = {}): NormalizedOptions {
  const location = options.location ?? "";
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_REDACTION_INPUT_BYTES;
  if (
    !isJsonPointer(location) ||
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 0 ||
    (options.stageHook !== undefined && typeof options.stageHook !== "function")
  ) {
    failRedaction("text validation");
  }

  const knownHashes = snapshotKnownHashes(options.knownHashes);
  for (const segment of jsonPointerSegments(location)) {
    const patternMatches = failClosed("text validation", () => findPatternMatches(segment));
    const entropyMatches = failClosed("text validation", () =>
      findEntropyMatches(maskMatches(segment, patternMatches), knownHashes)
    );
    if (patternMatches.length > 0 || entropyMatches.length > 0) {
      failRedaction("text validation");
    }
  }

  return {
    location,
    knownHashes,
    maxInputBytes,
    stageHook: options.stageHook
  };
}

export function redactionOptionsFromNormalized(
  options: NormalizedOptions
): RedactionOptions {
  return {
    location: options.location,
    knownHashes: options.knownHashes,
    maxInputBytes: options.maxInputBytes,
    ...(options.stageHook === undefined ? {} : { stageHook: options.stageHook })
  };
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function maskMatches(text: string, matches: readonly InternalMatch[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.start), " ".repeat(match.end - match.start));
    cursor = match.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export function manifestFromEntries(
  entries: readonly RedactionManifestEntry[]
): RedactionManifest {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + entry.count);
  }
  const matchCounts = Object.freeze(
    Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )
  );
  const applied = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({
    rulesetVersion: REDACTION_RULESET_VERSION,
    redactionCount: entries.reduce((total, entry) => total + entry.count, 0),
    matchCounts,
    applied
  });
}

export function mergeManifests(manifests: readonly RedactionManifest[]): RedactionManifest {
  return manifestFromEntries(manifests.flatMap((manifest) => manifest.applied));
}

export function emptyManifest(): RedactionManifest {
  return manifestFromEntries([]);
}

export function scanTextMatches(
  text: string,
  options: NormalizedOptions,
  contextKey?: string | undefined
): readonly InternalMatch[] {
  if (typeof text !== "string" || hasUnpairedSurrogate(text)) {
    failRedaction("text validation");
  }
  if (utf8ByteLength(text) > options.maxInputBytes) {
    failRedaction("text validation");
  }

  const patternMatches = failClosed("pattern detection", () => {
    options.stageHook?.("patterns");
    return findPatternMatches(text, contextKey);
  });

  const entropyMatches = failClosed("entropy detection", () => {
    options.stageHook?.("entropy");
    return findEntropyMatches(maskMatches(text, patternMatches), options.knownHashes);
  });

  return [...patternMatches, ...entropyMatches].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
}

function redactTextUnsafe(
  text: string,
  options: NormalizedOptions,
  contextKey?: string | undefined
): RedactionResult<string> {
  const matches = scanTextMatches(text, options, contextKey);
  let cursor = 0;
  const output: string[] = [];
  const entries: RedactionManifestEntry[] = [];

  for (const match of matches) {
    if (match.start < cursor || match.end <= match.start || match.end > text.length) {
      failRedaction("pattern detection");
    }
    const captured = text.slice(match.start, match.end);
    const byteLength = utf8ByteLength(captured);
    output.push(
      text.slice(cursor, match.start),
      `[REDACTED:${match.classification}:${byteLength}]`
    );
    entries.push({
      ruleId: match.ruleId,
      location: options.location,
      byteLength,
      count: 1
    });
    cursor = match.end;
  }
  output.push(text.slice(cursor));

  return { value: output.join(""), manifest: manifestFromEntries(entries) };
}

export function redactText(text: string, options: RedactionOptions = {}): RedactionResult<string> {
  return failClosed("text validation", () => redactTextUnsafe(text, normalizeOptions(options)));
}

export function redactTextWithContext(
  text: string,
  contextKey: string,
  options: RedactionOptions
): RedactionResult<string> {
  return failClosed("text validation", () =>
    redactTextUnsafe(text, normalizeOptions(options), contextKey)
  );
}
