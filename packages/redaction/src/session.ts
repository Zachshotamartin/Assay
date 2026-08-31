import { redactUtf8Bytes } from "./bytes.js";
import { RedactionError, failClosed, failRedaction } from "./error.js";
import {
  normalizeOptions,
  redactText,
  utf8ByteLength,
  type NormalizedOptions
} from "./text.js";
import {
  type RedactionOptions,
  type RedactionResult,
  type TextRedactionSession,
  type Utf8RedactionSession
} from "./types.js";

type SessionState = "active" | "failed" | "finished";

abstract class SessionStateGuard {
  protected state: SessionState = "active";

  protected clearSensitiveState(): void {
    // Concrete sessions release their buffered raw capture here.
  }

  protected requireActive(operation: "stream accumulation" | "stream finalization"): void {
    if (this.state !== "active") {
      failRedaction(operation);
    }
  }

  protected runWrite(action: () => void): void {
    this.requireActive("stream accumulation");
    try {
      action();
    } catch (error) {
      this.state = "failed";
      this.clearSensitiveState();
      if (error instanceof RedactionError) {
        throw error;
      }
      failRedaction("stream accumulation");
    }
  }

  protected runFinish<T>(action: () => RedactionResult<T>): RedactionResult<T> {
    this.requireActive("stream finalization");
    try {
      const result = action();
      this.state = "finished";
      return result;
    } catch (error) {
      this.state = "failed";
      this.clearSensitiveState();
      if (error instanceof RedactionError) {
        throw error;
      }
      failRedaction("stream finalization");
    }
  }
}

class BufferedTextRedactionSession extends SessionStateGuard implements TextRedactionSession {
  readonly #chunks: string[] = [];
  readonly #maximum: number;
  readonly #options: NormalizedOptions;
  #byteLength = 0;
  #endsWithHighSurrogate = false;

  constructor(options: RedactionOptions) {
    super();
    this.#options = normalizeOptions(options);
    this.#maximum = this.#options.maxInputBytes;
  }

  write(chunk: string): void {
    this.runWrite(() => {
      if (typeof chunk !== "string") {
        failRedaction("stream accumulation");
      }
      let additionalBytes = utf8ByteLength(chunk);
      if (
        this.#endsWithHighSurrogate &&
        chunk.length > 0 &&
        chunk.charCodeAt(0) >= 0xdc00 &&
        chunk.charCodeAt(0) <= 0xdfff
      ) {
        // TextEncoder counts either unpaired surrogate as three replacement
        // bytes. Joined frames encode the completed pair as four bytes.
        additionalBytes -= 2;
      }
      const nextByteLength = this.#byteLength + additionalBytes;
      if (nextByteLength > this.#maximum) {
        failRedaction("stream accumulation");
      }
      this.#byteLength = nextByteLength;
      if (chunk.length > 0) {
        const lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
        this.#endsWithHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
      }
      this.#chunks.push(chunk);
    });
  }

  finish(): RedactionResult<string> {
    return this.runFinish(() => {
      const joined = this.#chunks.join("");
      this.clearSensitiveState();
      return redactText(joined, this.#options);
    });
  }

  protected override clearSensitiveState(): void {
    this.#chunks.fill("");
    this.#chunks.length = 0;
    this.#byteLength = 0;
    this.#endsWithHighSurrogate = false;
  }
}

class BufferedUtf8RedactionSession extends SessionStateGuard implements Utf8RedactionSession {
  readonly #chunks: Uint8Array[] = [];
  readonly #maximum: number;
  readonly #options: NormalizedOptions;
  #byteLength = 0;

  constructor(options: RedactionOptions) {
    super();
    this.#options = normalizeOptions(options);
    this.#maximum = this.#options.maxInputBytes;
  }

  write(chunk: Uint8Array): void {
    this.runWrite(() => {
      if (!(chunk instanceof Uint8Array)) {
        failRedaction("stream accumulation");
      }
      this.#byteLength += chunk.byteLength;
      if (this.#byteLength > this.#maximum) {
        failRedaction("stream accumulation");
      }
      this.#chunks.push(Uint8Array.from(chunk));
    });
  }

  finish(): RedactionResult<Uint8Array> {
    return this.runFinish(() => {
      const joined = new Uint8Array(this.#byteLength);
      let offset = 0;
      for (const chunk of this.#chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.clearSensitiveState();
      return redactUtf8Bytes(joined, this.#options);
    });
  }

  protected override clearSensitiveState(): void {
    for (const chunk of this.#chunks) {
      chunk.fill(0);
    }
    this.#chunks.length = 0;
    this.#byteLength = 0;
  }
}

export function createTextRedactionSession(
  options: RedactionOptions = {}
): TextRedactionSession {
  return failClosed("stream accumulation", () => new BufferedTextRedactionSession(options));
}

export function createUtf8RedactionSession(
  options: RedactionOptions = {}
): Utf8RedactionSession {
  return failClosed("stream accumulation", () => new BufferedUtf8RedactionSession(options));
}
