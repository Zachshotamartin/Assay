import { failClosed, failRedaction } from "./error.js";
import {
  normalizeOptions,
  redactionOptionsFromNormalized,
  redactText
} from "./text.js";
import type { RedactionOptions, RedactionResult } from "./types.js";

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

export function decodeUtf8Strict(value: Uint8Array): string {
  return failClosed("UTF-8 decoding", () => strictUtf8Decoder.decode(value));
}

export function redactUtf8Bytes(
  value: Uint8Array,
  options: RedactionOptions = {}
): RedactionResult<Uint8Array> {
  return failClosed("UTF-8 decoding", () => {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    const normalized = normalizeOptions(options);
    if (value.byteLength > normalized.maxInputBytes) {
      failRedaction("text validation");
    }
    const decoded = decodeUtf8Strict(value);
    const redacted = redactText(decoded, redactionOptionsFromNormalized(normalized));
    return {
      value: utf8Encoder.encode(redacted.value),
      manifest: redacted.manifest
    };
  });
}
