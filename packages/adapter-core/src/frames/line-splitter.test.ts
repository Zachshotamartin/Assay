import { describe, expect, it } from "vitest";

import {
  AdapterLineSplitter,
  AdapterStreamBudget,
  BoundedHeadTailBuffer,
  MAX_ADAPTER_FRAME_BYTES,
  MAX_ADAPTER_FRAMES,
  MAX_ADAPTER_STDOUT_BYTES,
  MAX_ADAPTER_STDERR_BYTES,
  MAX_MALFORMED_DIAGNOSTIC_BYTES,
  MAX_MALFORMED_FRAMES,
  MAX_ADAPTER_STRING_BYTES
} from "./line-splitter.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("raw-byte adapter line splitter", () => {
  it("pins every Architecture section 6 and ADR-0014 byte/count bound", () => {
    expect(MAX_ADAPTER_FRAME_BYTES).toBe(1_048_576);
    expect(MAX_ADAPTER_FRAMES).toBe(50_000);
    expect(MAX_ADAPTER_STDOUT_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_ADAPTER_STRING_BYTES).toBe(262_144);
    expect(MAX_MALFORMED_FRAMES).toBe(10);
    expect(MAX_MALFORMED_DIAGNOSTIC_BYTES).toBe(4 * 1024);
    expect(MAX_ADAPTER_STDERR_BYTES).toBe(256 * 1024);
  });

  it("splits multiple LF frames while preserving a split UTF-8 code point", () => {
    const splitter = new AdapterLineSplitter();
    const bytes = encoder.encode('{"text":"🧪"}\n{"text":"ok"}\n');
    const splitInsideEmoji = bytes.indexOf(0xf0) + 2;

    expect(splitter.push(bytes.subarray(0, splitInsideEmoji))).toEqual([]);
    expect(splitter.push(bytes.subarray(splitInsideEmoji))).toEqual([
      { ok: true, text: '{"text":"🧪"}', byteLength: 16 },
      { ok: true, text: '{"text":"ok"}', byteLength: 14 }
    ]);
    expect(splitter.finish()).toEqual([]);
  });

  it.each([
    ["blank_line", new Uint8Array([0x0a])],
    ["carriage_return", encoder.encode("{}\r\n")],
    ["bom", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])],
    ["invalid_utf8", new Uint8Array([0xc3, 0x28, 0x0a])]
  ] as const)("classifies %s without decoding through replacement characters", (classification, bytes) => {
    const records = new AdapterLineSplitter().push(bytes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, classification });
    if (classification === "invalid_utf8") {
      expect(JSON.stringify(records[0])).not.toContain("�");
    }
  });

  it("accepts exactly 1 MiB including LF and discards an oversized body with bounded evidence", () => {
    const accepted = new Uint8Array(MAX_ADAPTER_FRAME_BYTES);
    accepted.fill(0x61, 0, accepted.length - 1);
    accepted[accepted.length - 1] = 0x0a;
    const acceptedRecords = new AdapterLineSplitter().push(accepted);
    expect(acceptedRecords).toHaveLength(1);
    expect(acceptedRecords[0]).toMatchObject({ ok: true, byteLength: MAX_ADAPTER_FRAME_BYTES });

    const oversized = new Uint8Array(MAX_ADAPTER_FRAME_BYTES + 1);
    oversized.fill(0x62, 0, oversized.length - 1);
    oversized[oversized.length - 1] = 0x0a;
    const rejectedRecords = new AdapterLineSplitter().push(oversized);
    expect(rejectedRecords).toHaveLength(1);
    expect(rejectedRecords[0]).toMatchObject({
      ok: false,
      classification: "oversized_frame",
      byteLength: MAX_ADAPTER_FRAME_BYTES + 1
    });
    expect(rejectedRecords[0]?.sample.byteLength).toBe(MAX_MALFORMED_DIAGNOSTIC_BYTES);
  });

  it("classifies an EOF partial frame and keeps only a 4 KiB sample", () => {
    const splitter = new AdapterLineSplitter();
    splitter.push(encoder.encode("x".repeat(8_000)));
    expect(splitter.finish()).toEqual([
      expect.objectContaining({
        ok: false,
        classification: "partial_frame",
        byteLength: 8_000,
        sample: expect.objectContaining({ byteLength: MAX_MALFORMED_DIAGNOSTIC_BYTES })
      })
    ]);
  });

  it("does not retain an unbounded oversized line before its LF arrives", () => {
    const splitter = new AdapterLineSplitter(8, 3);
    expect(splitter.push(encoder.encode("0123456789"))).toEqual([]);
    expect(splitter.bufferedByteLength).toBeLessThanOrEqual(3);
    expect(splitter.push(encoder.encode("abc\n"))).toEqual([
      expect.objectContaining({
        ok: false,
        classification: "oversized_frame",
        byteLength: 14,
        sample: encoder.encode("012")
      })
    ]);
  });
});

describe("stream and stderr bounds", () => {
  it("allows the exact stdout budgets and rejects the first byte or frame beyond them", () => {
    const bytes = new AdapterStreamBudget();
    expect(bytes.recordBytes(MAX_ADAPTER_STDOUT_BYTES)).toBe(true);
    expect(bytes.recordBytes(1)).toBe(false);

    const frames = new AdapterStreamBudget();
    expect(frames.recordFrames(MAX_ADAPTER_FRAMES)).toBe(true);
    expect(frames.recordFrames(1)).toBe(false);
  });

  it("retains bounded head and tail across arbitrary chunk boundaries", () => {
    const ring = new BoundedHeadTailBuffer(8);
    ring.push(encoder.encode("abc"));
    ring.push(encoder.encode("defgh"));
    ring.push(encoder.encode("ijkl"));

    const snapshot = ring.snapshot();
    expect(decoder.decode(snapshot.bytes)).toBe("abcdijkl");
    expect(snapshot.droppedBytes).toBe(4);
    expect(snapshot.bytes.byteLength).toBe(8);
  });
});
