import { failClosed, failRedaction, RedactionError } from "./error.js";
import {
  childLocation,
  cloneJsonValue,
  jsonUtf8ByteLength,
  redactJsonDeep,
  validateJsonValue
} from "./json.js";
import {
  manifestFromEntries,
  mergeManifests,
  normalizeOptions,
  redactionOptionsFromNormalized,
  redactText,
  scanTextMatches,
  utf8ByteLength,
  type NormalizedOptions
} from "./text.js";
import type {
  InternalMatch,
  JsonRedactionSession,
  JsonValue,
  RedactionManifest,
  RedactionManifestEntry,
  RedactionOptions,
  RedactionResult
} from "./types.js";

interface StringFragment {
  readonly id: number;
  readonly recordIndex: number;
  readonly location: string;
  readonly text: string;
  readonly contextKey?: string | undefined;
}

interface LocalHit extends InternalMatch {}

interface MappedMatch {
  readonly sequencePrecedence: number;
  readonly priority: number;
  readonly sequenceOrder: number;
  readonly coveredLength: number;
  readonly slices: readonly {
    readonly fragmentId: number;
    readonly hit: LocalHit;
  }[];
}

interface FragmentSequence {
  readonly fragments: readonly StringFragment[];
  readonly precedence: number;
  readonly contextKey?: string | undefined;
}

const MAX_SEQUENCE_COUNT = 65_536;
const MAX_SCAN_WORK_MULTIPLIER = 16;

interface KeyRedactionResult {
  readonly value: JsonValue;
  readonly manifest: RedactionManifest;
}

function redactKeysOnly(
  value: JsonValue,
  options: NormalizedOptions,
  location: string
): KeyRedactionResult {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return { value, manifest: manifestFromEntries([]) };
  }
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    const manifests: RedactionManifest[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = redactKeysOnly(
        value[index]!,
        options,
        childLocation(location, String(index))
      );
      values.push(child.value);
      manifests.push(child.manifest);
    }
    return { value: values, manifest: mergeManifests(manifests) };
  }

  const output: Record<string, JsonValue> = {};
  const manifests: RedactionManifest[] = [];
  const stableOptions = redactionOptionsFromNormalized(options);
  for (const [key, childValue] of Object.entries(value)) {
    const keyResult = redactText(key, { ...stableOptions, location });
    if (Object.hasOwn(output, keyResult.value)) {
      failRedaction("JSON traversal");
    }
    const child = redactKeysOnly(
      childValue,
      options,
      childLocation(location, keyResult.value)
    );
    Object.defineProperty(output, keyResult.value, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    manifests.push(keyResult.manifest, child.manifest);
  }
  return { value: output, manifest: mergeManifests(manifests) };
}

function decodePointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) {
    failRedaction("JSON traversal");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function resolveStringPointer(value: JsonValue, pointer: string): string {
  let current: JsonValue = value;
  for (const token of decodePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        failRedaction("JSON traversal");
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length || !Object.hasOwn(current, index)) {
        failRedaction("JSON traversal");
      }
      current = current[index]!;
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
      failRedaction("JSON traversal");
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (descriptor === undefined || !("value" in descriptor)) {
      failRedaction("JSON traversal");
    }
    current = descriptor.value as JsonValue;
  }
  if (typeof current !== "string") {
    failRedaction("JSON traversal");
  }
  return current;
}

function validateContinuationLocations(
  value: JsonValue,
  locations: readonly string[] | undefined
): readonly string[] {
  if (locations === undefined) {
    return [];
  }
  if (!Array.isArray(locations) || locations.length > MAX_SEQUENCE_COUNT) {
    failRedaction("JSON traversal");
  }
  const copy: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    if (typeof location !== "string" || seen.has(location)) {
      failRedaction("JSON traversal");
    }
    resolveStringPointer(value, location);
    seen.add(location);
    copy.push(location);
  }
  return Object.freeze(copy);
}

function composeLocation(base: string, pointer: string): string {
  if (pointer === "") {
    return base;
  }
  return `${base}${pointer}`;
}

function collectFragments(
  value: JsonValue,
  recordIndex: number,
  location: string,
  fragments: StringFragment[],
  contextKey?: string | undefined
): void {
  if (typeof value === "string") {
    fragments.push({
      id: fragments.length,
      recordIndex,
      location,
      text: value,
      ...(contextKey === undefined ? {} : { contextKey })
    });
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectFragments(
        value[index]!,
        recordIndex,
        childLocation(location, String(index)),
        fragments,
        contextKey
      );
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectFragments(child, recordIndex, childLocation(location, key), fragments, key);
  }
}

function buildSequences(
  records: readonly JsonValue[],
  continuationLocations: readonly (readonly string[])[],
  location: string,
  maxInputBytes: number
): { readonly fragments: readonly StringFragment[]; readonly sequences: readonly FragmentSequence[] } {
  const fragments: StringFragment[] = [];
  const byRecord: StringFragment[][] = records.map(() => []);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const before = fragments.length;
    collectFragments(records[recordIndex]!, recordIndex, location, fragments);
    byRecord[recordIndex] = fragments.slice(before);
  }

  // Each record is one ordered string sequence, which catches a secret split
  // across adjacent fields inside that record.
  const sequences: FragmentSequence[] = [];
  let scanWork = 0;
  const scanWorkLimit = Math.min(
    Number.MAX_SAFE_INTEGER,
    maxInputBytes * MAX_SCAN_WORK_MULTIPLIER
  );
  const appendSequence = (
    candidateFragments: readonly StringFragment[],
    precedence = 2,
    contextKey?: string | undefined
  ): void => {
    const nonEmpty = candidateFragments.filter((fragment) => fragment.text.length > 0);
    if (nonEmpty.length === 0) {
      return;
    }
    const candidateWork = nonEmpty.reduce((total, fragment) => total + fragment.text.length, 0);
    scanWork += candidateWork;
    if (sequences.length >= MAX_SEQUENCE_COUNT || scanWork > scanWorkLimit) {
      failRedaction("pattern detection");
    }
    sequences.push({
      fragments: nonEmpty,
      precedence,
      ...(contextKey === undefined ? {} : { contextKey })
    });
  };

  // Full single-leaf matches, including structured cloud fields whose key is
  // semantically significant, arbitrate before heuristic concatenations.
  for (const fragment of fragments) {
    appendSequence([fragment], 1, fragment.contextKey);
  }

  for (const recordFragments of byRecord) {
    appendSequence(recordFragments);
  }

  if (continuationLocations.length !== records.length) {
    failRedaction("JSON traversal");
  }
  const explicitLane: StringFragment[] = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    for (const pointer of continuationLocations[recordIndex]!) {
      // Re-resolve after key redaction. If a caller selected through a key
      // that was itself sensitive, fail closed instead of retaining that raw
      // key in a location.
      resolveStringPointer(records[recordIndex]!, pointer);
      const fullLocation = composeLocation(location, pointer);
      const fragment = byRecord[recordIndex]!.find(
        (candidate) => candidate.location === fullLocation
      );
      if (fragment === undefined) {
        failRedaction("JSON traversal");
      }
      explicitLane.push(fragment);
    }
  }
  appendSequence(explicitLane, 0);

  // Preserve ordinal value position across records as another continuation
  // lane. Unlike flattening every record into one stream, this does not place
  // a discriminator such as `type` between adjacent `text` deltas.
  const maximumOrdinal = byRecord.reduce(
    (maximum, recordFragments) => Math.max(maximum, recordFragments.length),
    0
  );
  for (let ordinal = 0; ordinal < maximumOrdinal; ordinal += 1) {
    let run: StringFragment[] = [];
    for (const recordFragments of byRecord) {
      const fragment = recordFragments[ordinal];
      if (fragment === undefined) {
        if (run.length > 1) {
          appendSequence(run);
        }
        run = [];
      } else {
        run.push(fragment);
      }
    }
    if (run.length > 1) {
      appendSequence(run);
    }
  }

  // Corresponding JSON-pointer locations form lanes across consecutive
  // records. This is the adapter-delta seam: metadata fields cannot be
  // inserted between two fragments of the same logical output field.
  const activeLanes = new Map<string, StringFragment[]>();
  const completedLanes: StringFragment[][] = [];
  for (let recordIndex = 0; recordIndex < byRecord.length; recordIndex += 1) {
    const seen = new Set<string>();
    for (const fragment of byRecord[recordIndex]!) {
      seen.add(fragment.location);
      const active = activeLanes.get(fragment.location);
      if (active !== undefined && active.at(-1)?.recordIndex === recordIndex - 1) {
        active.push(fragment);
      } else {
        if (active !== undefined && active.length > 1) {
          completedLanes.push(active);
        }
        activeLanes.set(fragment.location, [fragment]);
      }
    }
    for (const [laneLocation, active] of activeLanes) {
      if (!seen.has(laneLocation) && active.at(-1)?.recordIndex === recordIndex - 1) {
        if (active.length > 1) {
          completedLanes.push(active);
        }
        activeLanes.delete(laneLocation);
      }
    }
  }
  for (const active of activeLanes.values()) {
    if (active.length > 1) {
      completedLanes.push(active);
    }
  }
  for (const lane of completedLanes) {
    appendSequence(lane);
  }

  // A schema can move streamed text between event variants (for example,
  // `delta` followed by `result`). Scan every string pair across adjacent
  // records so a field-name change cannot create a boundary-evasion gap.
  for (let recordIndex = 0; recordIndex + 1 < byRecord.length; recordIndex += 1) {
    for (const left of byRecord[recordIndex]!) {
      for (const right of byRecord[recordIndex + 1]!) {
        appendSequence([left, right]);
      }
    }
  }

  return { fragments, sequences };
}

function scanSequences(
  fragments: readonly StringFragment[],
  sequences: readonly FragmentSequence[],
  options: NormalizedOptions
): readonly (readonly LocalHit[])[] {
  const hitsByFragment: LocalHit[][] = fragments.map(() => []);
  const ownerByFragment = fragments.map(
    (fragment) => new Int32Array(fragment.text.length).fill(-1)
  );
  const mappedMatches: MappedMatch[] = [];

  for (let sequenceOrder = 0; sequenceOrder < sequences.length; sequenceOrder += 1) {
    const sequence = sequences[sequenceOrder]!;
    const offsets: number[] = [];
    let cursor = 0;
    const textParts: string[] = [];
    for (const fragment of sequence.fragments) {
      offsets.push(cursor);
      textParts.push(fragment.text);
      cursor += fragment.text.length;
    }
    const matches = scanTextMatches(textParts.join(""), options, sequence.contextKey);

    let fragmentCursor = 0;
    for (const match of matches) {
      const slices: { readonly fragmentId: number; readonly hit: LocalHit }[] = [];
      while (fragmentCursor < sequence.fragments.length) {
        const fragment = sequence.fragments[fragmentCursor]!;
        const fragmentStart = offsets[fragmentCursor]!;
        if (fragmentStart + fragment.text.length > match.start) {
          break;
        }
        fragmentCursor += 1;
      }
      for (let index = fragmentCursor; index < sequence.fragments.length; index += 1) {
        const fragment = sequence.fragments[index]!;
        const fragmentStart = offsets[index]!;
        const fragmentEnd = fragmentStart + fragment.text.length;
        if (fragmentStart >= match.end) {
          break;
        }
        const intersectionStart = Math.max(match.start, fragmentStart);
        const intersectionEnd = Math.min(match.end, fragmentEnd);
        if (intersectionStart >= intersectionEnd) {
          continue;
        }
        const localHit: LocalHit = {
          start: intersectionStart - fragmentStart,
          end: intersectionEnd - fragmentStart,
          ruleId: match.ruleId,
          classification: match.classification,
          priority: match.priority
        };
        slices.push({ fragmentId: fragment.id, hit: localHit });
      }
      if (slices.length > 0) {
        mappedMatches.push({
          sequencePrecedence: sequence.precedence,
          priority: match.priority,
          sequenceOrder,
          coveredLength: slices.reduce(
            (total, { hit }) => total + (hit.end - hit.start),
            0
          ),
          slices
        });
      }
    }
  }

  mappedMatches.sort(
    (left, right) =>
      left.sequencePrecedence - right.sequencePrecedence ||
      right.slices.length - left.slices.length ||
      right.coveredLength - left.coveredLength ||
      left.priority - right.priority ||
      left.sequenceOrder - right.sequenceOrder
  );

  const selected: MappedMatch[] = [];
  const active: boolean[] = [];

  const contains = (outer: MappedMatch, inner: MappedMatch): boolean =>
    inner.slices.every(({ fragmentId, hit }) =>
      outer.slices.some(
        (candidate) =>
          candidate.fragmentId === fragmentId &&
          candidate.hit.start <= hit.start &&
          candidate.hit.end >= hit.end
      )
    );

  const removeSelected = (selectedId: number): void => {
    const removed = selected[selectedId];
    if (removed === undefined || active[selectedId] !== true) {
      failRedaction("pattern detection");
    }
    active[selectedId] = false;
    for (const { fragmentId, hit } of removed.slices) {
      const owners = ownerByFragment[fragmentId]!;
      for (let index = hit.start; index < hit.end; index += 1) {
        if (owners[index] === selectedId) {
          owners[index] = -1;
        }
      }
    }
  };

  const addSelected = (mapped: MappedMatch): void => {
    const selectedId = selected.length;
    selected.push(mapped);
    active.push(true);
    for (const { fragmentId, hit } of mapped.slices) {
      ownerByFragment[fragmentId]!.fill(selectedId, hit.start, hit.end);
    }
  };

  const mergeMatches = (matches: readonly MappedMatch[]): MappedMatch => {
    const template = [...matches].sort(
      (left, right) =>
        left.sequencePrecedence - right.sequencePrecedence ||
        left.priority - right.priority ||
        left.sequenceOrder - right.sequenceOrder
    )[0];
    if (template === undefined) {
      failRedaction("pattern detection");
    }
    const byFragment = new Map<number, LocalHit[]>();
    for (const mapped of matches) {
      for (const { fragmentId, hit } of mapped.slices) {
        const intervals = byFragment.get(fragmentId) ?? [];
        intervals.push(hit);
        byFragment.set(fragmentId, intervals);
      }
    }
    const slices: { readonly fragmentId: number; readonly hit: LocalHit }[] = [];
    for (const [fragmentId, intervals] of [...byFragment.entries()].sort(
      ([left], [right]) => left - right
    )) {
      intervals.sort((left, right) => left.start - right.start || left.end - right.end);
      let start = intervals[0]!.start;
      let end = intervals[0]!.end;
      for (const interval of intervals.slice(1)) {
        if (interval.start <= end) {
          end = Math.max(end, interval.end);
          continue;
        }
        slices.push({
          fragmentId,
          hit: {
            start,
            end,
            ruleId: template.slices[0]!.hit.ruleId,
            classification: template.slices[0]!.hit.classification,
            priority: template.priority
          }
        });
        start = interval.start;
        end = interval.end;
      }
      slices.push({
        fragmentId,
        hit: {
          start,
          end,
          ruleId: template.slices[0]!.hit.ruleId,
          classification: template.slices[0]!.hit.classification,
          priority: template.priority
        }
      });
    }
    return {
      sequencePrecedence: template.sequencePrecedence,
      priority: template.priority,
      sequenceOrder: template.sequenceOrder,
      coveredLength: slices.reduce(
        (total, { hit }) => total + (hit.end - hit.start),
        0
      ),
      slices
    };
  };

  for (const mapped of mappedMatches) {
    const conflictingIds = new Set<number>();
    for (const { fragmentId, hit } of mapped.slices) {
      const owners = ownerByFragment[fragmentId]!;
      for (let index = hit.start; index < hit.end; index += 1) {
        const owner = owners[index]!;
        if (owner >= 0) {
          conflictingIds.add(owner);
        }
      }
    }
    if (conflictingIds.size === 0) {
      addSelected(mapped);
      continue;
    }

    const conflicts = [...conflictingIds].map((selectedId) => selected[selectedId]!);
    const conflictsIncludeExplicit = conflicts.some(
      (conflict) => conflict.sequencePrecedence === 0
    );
    if (conflictsIncludeExplicit && mapped.sequencePrecedence > 0) {
      if (
        mapped.sequencePrecedence === 1 &&
        !conflicts.every((conflict) => contains(conflict, mapped))
      ) {
        for (const selectedId of conflictingIds) {
          removeSelected(selectedId);
        }
        addSelected(mergeMatches([mapped, ...conflicts]));
      }
      continue;
    }

    const mappedContainsEveryConflict = conflicts.every((conflict) =>
      contains(mapped, conflict)
    );
    const atLeastOneStrictlyContained = conflicts.some(
      (conflict) => !contains(conflict, mapped)
    );
    if (mappedContainsEveryConflict && atLeastOneStrictlyContained) {
      for (const selectedId of conflictingIds) {
        removeSelected(selectedId);
      }
      addSelected(mapped);
      continue;
    }

    if (conflicts.every((conflict) => contains(conflict, mapped))) {
      continue;
    }

    // Heuristic concatenations never partially occlude a complete local
    // credential. The schema-authoritative explicit lane is merged with a
    // partially overlapping local match so neither matched span can leak.
    if (mapped.sequencePrecedence === 0) {
      for (const selectedId of conflictingIds) {
        removeSelected(selectedId);
      }
      addSelected(mergeMatches([mapped, ...conflicts]));
    }
  }

  for (let selectedId = 0; selectedId < selected.length; selectedId += 1) {
    if (active[selectedId] !== true) {
      continue;
    }
    for (const { fragmentId, hit } of selected[selectedId]!.slices) {
      hitsByFragment[fragmentId]!.push(hit);
    }
  }

  for (const hits of hitsByFragment) {
    hits.sort((left, right) => left.start - right.start || left.end - right.end);
  }
  return hitsByFragment;
}

function redactFragments(
  fragments: readonly StringFragment[],
  hitsByFragment: readonly (readonly LocalHit[])[],
  recordCount: number
): {
  readonly values: readonly string[];
  readonly entriesByRecord: readonly (readonly RedactionManifestEntry[])[];
} {
  const values: string[] = [];
  const entriesByRecord: RedactionManifestEntry[][] = Array.from(
    { length: recordCount },
    () => []
  );

  for (const fragment of fragments) {
    const parts: string[] = [];
    let cursor = 0;
    for (const hit of hitsByFragment[fragment.id]!) {
      const captured = fragment.text.slice(hit.start, hit.end);
      const byteLength = utf8ByteLength(captured);
      parts.push(
        fragment.text.slice(cursor, hit.start),
        `[REDACTED:${hit.classification}:${byteLength}]`
      );
      entriesByRecord[fragment.recordIndex]!.push({
        ruleId: hit.ruleId,
        location: fragment.location,
        byteLength,
        count: 1
      });
      cursor = hit.end;
    }
    parts.push(fragment.text.slice(cursor));
    values[fragment.id] = parts.join("");
  }

  return { values, entriesByRecord };
}

function rebuildRecord(value: JsonValue, fragmentValues: readonly string[], cursor: { value: number }): JsonValue {
  if (typeof value === "string") {
    const replacement = fragmentValues[cursor.value];
    cursor.value += 1;
    if (replacement === undefined) {
      failRedaction("JSON traversal");
    }
    return replacement;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => rebuildRecord(child, fragmentValues, cursor));
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: rebuildRecord(child, fragmentValues, cursor),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function redactRecordWindow(
  records: readonly JsonValue[],
  continuationLocations: readonly (readonly string[])[],
  options: NormalizedOptions
): readonly RedactionResult<JsonValue>[] {
  const keyResults = records.map((record) =>
    redactKeysOnly(record, options, options.location)
  );
  const keySafeRecords = keyResults.map((result) => result.value);
  const { fragments, sequences } = buildSequences(
    keySafeRecords,
    continuationLocations,
    options.location,
    options.maxInputBytes
  );
  const hits = scanSequences(fragments, sequences, options);
  const { values, entriesByRecord } = redactFragments(fragments, hits, records.length);
  const cursor = { value: 0 };

  return Object.freeze(
    keySafeRecords.map((record, recordIndex) => {
      const rebuilt = rebuildRecord(record, values, cursor);
      const deepOptions: RedactionOptions = {
        location: options.location,
        knownHashes: options.knownHashes,
        maxInputBytes: options.maxInputBytes,
        ...(options.stageHook === undefined ? {} : { stageHook: options.stageHook })
      };
      const deep = redactJsonDeep(rebuilt, deepOptions);
      const boundaryManifest = manifestFromEntries(entriesByRecord[recordIndex]!);
      return Object.freeze({
        value: deep.value,
        manifest: mergeManifests([
          keyResults[recordIndex]!.manifest,
          boundaryManifest,
          deep.manifest
        ])
      });
    })
  );
}

class BufferedJsonRedactionSession implements JsonRedactionSession {
  readonly #records: JsonValue[] = [];
  readonly #continuationLocations: (readonly string[])[] = [];
  readonly #options: NormalizedOptions;
  #byteLength = 0;
  #state: "active" | "failed" | "finished" = "active";

  constructor(options: RedactionOptions) {
    this.#options = normalizeOptions(options);
  }

  write(value: unknown, continuationLocations?: readonly string[] | undefined): void {
    this.#requireActive("stream accumulation");
    try {
      validateJsonValue(value);
      const validatedLocations = validateContinuationLocations(
        value,
        continuationLocations
      );
      const remaining = this.#options.maxInputBytes - this.#byteLength;
      const recordByteLength = jsonUtf8ByteLength(value, remaining);
      const nextByteLength = this.#byteLength + recordByteLength + 1;
      if (nextByteLength > this.#options.maxInputBytes) {
        failRedaction("stream accumulation");
      }
      this.#records.push(cloneJsonValue(value));
      this.#continuationLocations.push(validatedLocations);
      this.#byteLength = nextByteLength;
    } catch (error) {
      this.#fail(error, "stream accumulation");
    }
  }

  finish(): readonly RedactionResult<JsonValue>[] {
    this.#requireActive("stream finalization");
    const records = this.#records.splice(0);
    const continuationLocations = this.#continuationLocations.splice(0);
    this.#byteLength = 0;
    try {
      const result = redactRecordWindow(
        records,
        continuationLocations,
        this.#options
      );
      this.#state = "finished";
      return result;
    } catch (error) {
      this.#fail(error, "stream finalization");
    }
  }

  #requireActive(operation: "stream accumulation" | "stream finalization"): void {
    if (this.#state !== "active") {
      failRedaction(operation);
    }
  }

  #fail(error: unknown, operation: "stream accumulation" | "stream finalization"): never {
    this.#records.length = 0;
    this.#continuationLocations.length = 0;
    this.#byteLength = 0;
    this.#state = "failed";
    if (error instanceof RedactionError) {
      throw error;
    }
    failRedaction(operation);
  }
}

export function createJsonRedactionSession(
  options: RedactionOptions = {}
): JsonRedactionSession {
  return failClosed("stream accumulation", () => new BufferedJsonRedactionSession(options));
}
