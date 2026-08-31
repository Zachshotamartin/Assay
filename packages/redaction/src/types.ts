export const REDACTION_RULESET_VERSION = "2026.08" as const;
export const DEFAULT_MAX_REDACTION_INPUT_BYTES = 1_048_576;

export type RedactionStage = "patterns" | "entropy";

export interface RedactionManifestEntry {
  readonly ruleId: string;
  readonly location: string;
  readonly byteLength: number;
  readonly count: number;
}

export interface RedactionManifest {
  readonly rulesetVersion: typeof REDACTION_RULESET_VERSION;
  readonly redactionCount: number;
  readonly matchCounts: Readonly<Record<string, number>>;
  readonly applied: readonly RedactionManifestEntry[];
}

export interface RedactionResult<T> {
  readonly value: T;
  readonly manifest: RedactionManifest;
}

/**
 * All variability is injected per run. In particular, content-hash exemptions
 * are never discovered from process state or persistent configuration.
 */
export interface RedactionOptions {
  /** RFC 6901 JSON pointer identifying the capture surface. */
  readonly location?: string | undefined;
  /** Exact content hashes known to this run. Prefix and substring matches do not exempt. */
  readonly knownHashes?: ReadonlySet<string> | undefined;
  /**
   * Maximum raw input accepted before any detector runs. A buffered session
   * applies this bound to its complete, not-yet-released capture window.
   */
  readonly maxInputBytes?: number | undefined;
  /** Injected test/telemetry seam. It can observe or fail a stage, but cannot alter a result. */
  readonly stageHook?: ((stage: RedactionStage) => void) | undefined;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface TextRedactionSession {
  write(chunk: string): void;
  finish(): RedactionResult<string>;
}

export interface Utf8RedactionSession {
  write(chunk: Uint8Array): void;
  finish(): RedactionResult<Uint8Array>;
}

/**
 * Buffers a bounded logical-record window. No record is returned until the
 * complete window has been scanned, including string continuations at record
 * boundaries.
 */
export interface JsonRedactionSession {
  /**
   * Adds one JSON record to the bounded window. `continuationLocations` is
   * snapshotted immediately and must contain unique RFC 6901 pointers to
   * string leaves in this record. Across writes, the selected strings form
   * one authoritative semantic lane for boundary-spanning detection.
   */
  write(value: unknown, continuationLocations?: readonly string[] | undefined): void;
  /** Finalizes every record together; no record is released before this call. */
  finish(): readonly RedactionResult<JsonValue>[];
}

export interface InternalMatch {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly classification: string;
  readonly priority: number;
}
