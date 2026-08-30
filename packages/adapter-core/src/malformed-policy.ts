import { AssayError } from "@assay/contracts";

import {
  MAX_MALFORMED_DIAGNOSTIC_BYTES,
  MAX_MALFORMED_FRAMES,
  type AdapterLineFaultClassification
} from "./frames/line-splitter.js";

export interface AdapterCaptureRedactor {
  redactJson(value: unknown): unknown;
  redactBytes(value: Uint8Array): string;
}

export type MalformedFrameClassification =
  | AdapterLineFaultClassification
  | "invalid_json"
  | "schema_validation"
  | "sequence"
  | "cross_frame"
  | "post_terminal";

export interface MalformedFrameDiagnostic {
  readonly classification: MalformedFrameClassification;
  readonly byteLength: number;
  readonly redactedSample: string;
}

function truncateUtf8(value: string, limit: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= limit) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = limit;
  while (end >= 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export class MalformedFramePolicy {
  readonly #redactor: AdapterCaptureRedactor;
  readonly #diagnostics: MalformedFrameDiagnostic[] = [];
  #count = 0;

  constructor(redactor: AdapterCaptureRedactor) {
    this.#redactor = redactor;
  }

  get count(): number {
    return this.#count;
  }

  get exceeded(): boolean {
    return this.#count > MAX_MALFORMED_FRAMES;
  }

  get diagnostics(): readonly MalformedFrameDiagnostic[] {
    return [...this.#diagnostics];
  }

  record(
    classification: MalformedFrameClassification,
    bytes: Uint8Array,
    byteLength = bytes.byteLength
  ): void {
    this.#count += 1;
    const bounded = bytes.subarray(0, MAX_MALFORMED_DIAGNOSTIC_BYTES);
    let redactedSample: string;
    try {
      redactedSample = truncateUtf8(
        this.#redactor.redactBytes(bounded),
        MAX_MALFORMED_DIAGNOSTIC_BYTES
      );
    } catch (cause) {
      throw new AssayError(
        "redaction_failed",
        "redaction_failed: adapter diagnostic could not be redacted",
        { cause }
      );
    }
    this.#diagnostics.push({ classification, byteLength, redactedSample });
  }
}
