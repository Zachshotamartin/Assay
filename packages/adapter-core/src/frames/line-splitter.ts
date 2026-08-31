export const MAX_ADAPTER_FRAME_BYTES = 1_048_576;
export const MAX_ADAPTER_FRAMES = 50_000;
export const MAX_ADAPTER_STDOUT_BYTES = 256 * 1024 * 1024;
export const MAX_ADAPTER_STRING_BYTES = 262_144;
export const MAX_MALFORMED_FRAMES = 10;
export const MAX_MALFORMED_DIAGNOSTIC_BYTES = 4 * 1024;
export const MAX_ADAPTER_STDERR_BYTES = 256 * 1024;

export type AdapterLineFaultClassification =
  | "blank_line"
  | "carriage_return"
  | "bom"
  | "invalid_utf8"
  | "oversized_frame"
  | "partial_frame";

export type AdapterLineRecord =
  | {
      readonly ok: true;
      readonly text: string;
      readonly byteLength: number;
      readonly sample?: never;
    }
  | {
      readonly ok: false;
      readonly classification: AdapterLineFaultClassification;
      readonly byteLength: number;
      readonly sample: Uint8Array;
    };

const LF = 0x0a;
const CR = 0x0d;
const BOM = [0xef, 0xbb, 0xbf] as const;
const textEncoder = new TextEncoder();

function copyBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export class AdapterLineSplitter {
  readonly #frameLimit: number;
  readonly #sampleLimit: number;
  readonly #body: Uint8Array;
  readonly #sample: Uint8Array;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #bodyLength = 0;
  #lineByteLength = 0;
  #sampleLength = 0;
  #oversized = false;
  #finished = false;

  constructor(
    frameLimit = MAX_ADAPTER_FRAME_BYTES,
    sampleLimit = MAX_MALFORMED_DIAGNOSTIC_BYTES
  ) {
    if (!Number.isSafeInteger(frameLimit) || frameLimit < 1) {
      throw new RangeError("frameLimit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0) {
      throw new RangeError("sampleLimit must be a non-negative safe integer");
    }
    this.#frameLimit = frameLimit;
    this.#sampleLimit = sampleLimit;
    this.#body = new Uint8Array(Math.max(0, frameLimit - 1));
    this.#sample = new Uint8Array(sampleLimit);
  }

  get bufferedByteLength(): number {
    return this.#oversized ? this.#sampleLength : this.#bodyLength;
  }

  push(chunk: Uint8Array): readonly AdapterLineRecord[] {
    if (this.#finished) {
      throw new Error("cannot push adapter stdout after EOF");
    }
    const records: AdapterLineRecord[] = [];
    for (const byte of chunk) {
      if (byte === LF) {
        records.push(this.#completeLine());
        continue;
      }
      this.#lineByteLength += 1;
      if (this.#sampleLength < this.#sampleLimit) {
        this.#sample[this.#sampleLength] = byte;
        this.#sampleLength += 1;
      }
      if (!this.#oversized) {
        if (this.#lineByteLength > this.#frameLimit - 1) {
          this.#oversized = true;
          this.#bodyLength = 0;
        } else {
          this.#body[this.#bodyLength] = byte;
          this.#bodyLength += 1;
        }
      }
    }
    return records;
  }

  finish(): readonly AdapterLineRecord[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;
    if (this.#lineByteLength === 0) {
      return [];
    }
    const record: AdapterLineRecord = this.#oversized
      ? this.#fault("oversized_frame", this.#lineByteLength)
      : this.#fault("partial_frame", this.#lineByteLength);
    this.#reset();
    return [record];
  }

  #completeLine(): AdapterLineRecord {
    const byteLength = this.#lineByteLength + 1;
    let record: AdapterLineRecord;
    if (this.#oversized || byteLength > this.#frameLimit) {
      record = this.#fault("oversized_frame", byteLength);
    } else if (this.#bodyLength === 0) {
      record = this.#fault("blank_line", byteLength);
    } else {
      const body = this.#body.subarray(0, this.#bodyLength);
      if (body.includes(CR)) {
        record = this.#fault("carriage_return", byteLength);
      } else if (
        body.length >= BOM.length &&
        body[0] === BOM[0] &&
        body[1] === BOM[1] &&
        body[2] === BOM[2]
      ) {
        record = this.#fault("bom", byteLength);
      } else {
        try {
          record = { ok: true, text: this.#decoder.decode(body), byteLength };
        } catch {
          record = this.#fault("invalid_utf8", byteLength);
        }
      }
    }
    this.#reset();
    return record;
  }

  #fault(classification: AdapterLineFaultClassification, byteLength: number): AdapterLineRecord {
    return {
      ok: false,
      classification,
      byteLength,
      sample: copyBytes(this.#sample.subarray(0, this.#sampleLength))
    };
  }

  #reset(): void {
    this.#bodyLength = 0;
    this.#lineByteLength = 0;
    this.#sampleLength = 0;
    this.#oversized = false;
  }
}

export class AdapterStreamBudget {
  #bytes = 0;
  #frames = 0;

  get bytes(): number {
    return this.#bytes;
  }

  get frames(): number {
    return this.#frames;
  }

  recordBytes(count: number): boolean {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("stdout byte count must be a non-negative safe integer");
    }
    this.#bytes += count;
    return this.#bytes <= MAX_ADAPTER_STDOUT_BYTES;
  }

  recordFrames(count = 1): boolean {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("stdout frame count must be a non-negative safe integer");
    }
    this.#frames += count;
    return this.#frames <= MAX_ADAPTER_FRAMES;
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

export interface HeadTailSnapshot {
  readonly bytes: Uint8Array;
  readonly droppedBytes: number;
}

export class BoundedHeadTailBuffer {
  readonly #limit: number;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #initial = new Uint8Array();
  #head = new Uint8Array();
  #tail = new Uint8Array();
  #totalBytes = 0;
  #overflowed = false;

  constructor(limit = MAX_ADAPTER_STDERR_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("stderr limit must be a non-negative safe integer");
    }
    this.#limit = limit;
    this.#headLimit = Math.floor(limit / 2);
    this.#tailLimit = limit - this.#headLimit;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.#totalBytes += chunk.byteLength;
    if (!this.#overflowed && this.#initial.byteLength + chunk.byteLength <= this.#limit) {
      this.#initial = concatBytes(this.#initial, chunk);
      return;
    }

    if (!this.#overflowed) {
      this.#overflowed = true;
      this.#head = this.#firstBytes(this.#initial, chunk, this.#headLimit);
      this.#tail = this.#lastBytes(this.#initial, chunk, this.#tailLimit);
      this.#initial = new Uint8Array();
      return;
    }

    if (chunk.byteLength >= this.#tailLimit) {
      this.#tail = copyBytes(chunk.subarray(chunk.byteLength - this.#tailLimit));
    } else {
      const combined = concatBytes(this.#tail, chunk);
      this.#tail = copyBytes(combined.subarray(Math.max(0, combined.byteLength - this.#tailLimit)));
    }
  }

  snapshot(): HeadTailSnapshot {
    if (!this.#overflowed) {
      const bytes = copyBytes(this.#initial);
      return { bytes, droppedBytes: 0 };
    }

    let droppedBytes = Math.max(0, this.#totalBytes - this.#limit);
    let marker = textEncoder.encode(`...[${droppedBytes} bytes elided]...`);
    if (marker.byteLength > this.#limit) {
      const bytes = concatBytes(this.#head, this.#tail);
      return {
        bytes,
        droppedBytes: Math.max(0, this.#totalBytes - bytes.byteLength)
      };
    }

    // The marker itself consumes capture space. Its decimal byte count can
    // change the marker width, so converge before selecting the retained data.
    for (;;) {
      const retainedBytes = this.#limit - marker.byteLength;
      const nextDroppedBytes = Math.max(0, this.#totalBytes - retainedBytes);
      const nextMarker = textEncoder.encode(`...[${nextDroppedBytes} bytes elided]...`);
      if (nextDroppedBytes === droppedBytes && nextMarker.byteLength === marker.byteLength) break;
      droppedBytes = nextDroppedBytes;
      marker = nextMarker;
    }

    const retainedBytes = this.#limit - marker.byteLength;
    const headBytes = Math.floor(retainedBytes / 2);
    const tailBytes = retainedBytes - headBytes;
    const head = this.#head.subarray(0, headBytes);
    const tail = this.#tail.subarray(Math.max(0, this.#tail.byteLength - tailBytes));
    const bytes = concatBytes(concatBytes(head, marker), tail);
    return {
      bytes,
      droppedBytes
    };
  }

  #firstBytes(
    existing: Uint8Array,
    chunk: Uint8Array,
    count: number
  ): Uint8Array<ArrayBuffer> {
    if (count === 0) return new Uint8Array();
    if (existing.byteLength >= count) return copyBytes(existing.subarray(0, count));
    return concatBytes(existing, chunk.subarray(0, count - existing.byteLength));
  }

  #lastBytes(
    existing: Uint8Array,
    chunk: Uint8Array,
    count: number
  ): Uint8Array<ArrayBuffer> {
    if (count === 0) return new Uint8Array();
    if (chunk.byteLength >= count) return copyBytes(chunk.subarray(chunk.byteLength - count));
    const needed = count - chunk.byteLength;
    return concatBytes(existing.subarray(Math.max(0, existing.byteLength - needed)), chunk);
  }
}
