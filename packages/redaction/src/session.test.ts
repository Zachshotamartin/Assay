import { describe, expect, it } from "vitest";

import {
  createJsonRedactionSession,
  createTextRedactionSession,
  createUtf8RedactionSession
} from "./index.js";

const OPENAI_KEY = "sk-proj-SYNTHETIC0123456789abcdefghijklmnopqrstuv";

describe("buffered redaction sessions", () => {
  it("detects a provider key split across arbitrary text frames", () => {
    const session = createTextRedactionSession({ location: "/adapter_event" });

    expect(session.write("model response: sk-proj-SYNTHETIC0123")).toBeUndefined();
    expect(session.write("456789abcdefghijklmnopqrstuv done")).toBeUndefined();
    const result = session.finish();

    expect(result.value).not.toContain(OPENAI_KEY);
    expect(result.manifest.matchCounts).toEqual({ "provider-openai": 1 });
  });

  it("detects a planted token split across UTF-8 byte frames", () => {
    const bytes = new TextEncoder().encode(`tool=${OPENAI_KEY}`);
    const split = bytes.indexOf(new TextEncoder().encode("SYNTHETIC")[0]!) + 4;
    const session = createUtf8RedactionSession({ location: "/tool/output" });

    session.write(bytes.slice(0, split));
    session.write(bytes.slice(split));
    const result = session.finish();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.value);

    expect(output).not.toContain(OPENAI_KEY);
    expect(result.manifest.applied[0]?.location).toBe("/tool/output");
  });

  it("detects a base64-wrapped credential split across text frames", () => {
    const wrapped = Buffer.from(`planted:${OPENAI_KEY}`, "utf8").toString("base64");
    const session = createTextRedactionSession({ location: "/diagnostic" });

    session.write(wrapped.slice(0, 17));
    session.write(wrapped.slice(17));
    const result = session.finish();

    expect(result.value).not.toContain(wrapped);
    expect(result.manifest.matchCounts).toEqual({ entropy: 1 });
  });

  it("allows a multibyte UTF-8 scalar to straddle byte frames", () => {
    const bytes = new TextEncoder().encode(`snowman=☃;${OPENAI_KEY}`);
    const snowmanStart = bytes.indexOf(0xe2);
    const session = createUtf8RedactionSession();

    session.write(bytes.slice(0, snowmanStart + 1));
    session.write(bytes.slice(snowmanStart + 1));
    const result = session.finish();

    expect(new TextDecoder("utf-8", { fatal: true }).decode(result.value)).toContain("snowman=☃");
  });

  it("copies Node Buffer chunks instead of retaining a shared slice", () => {
    const source = Buffer.from(`stderr=${OPENAI_KEY}`, "utf8");
    const session = createUtf8RedactionSession();
    session.write(source);
    source.fill(0x78);

    const result = session.finish();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.value);
    expect(output).toContain("[REDACTED:provider-openai:");
    expect(source.every((byte) => byte === 0x78)).toBe(true);
  });

  it("fails closed when accumulated frames exceed the configured bound", () => {
    const session = createTextRedactionSession({ maxInputBytes: 5 });
    session.write("123");

    expect(() => session.write("456")).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
    expect(() => session.finish()).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("cannot be reused after finishing", () => {
    const session = createTextRedactionSession();
    session.write("safe");
    expect(session.finish().value).toBe("safe");

    expect(() => session.write("later")).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
    expect(() => session.finish()).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("snapshots known hash exemptions when a session is created", () => {
    const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const knownHashes = new Set([hash]);
    const session = createTextRedactionSession({ knownHashes });
    knownHashes.clear();
    session.write(hash);

    expect(session.finish().value).toBe(hash);
  });
});

describe("logical JSON record sessions", () => {
  it("redacts a provider key split across adjacent logical event records", () => {
    const firstSecretFragment = "sk-proj-SYNTHETIC0123";
    const secondSecretFragment = "456789abcdefghijklmnopqrstuv";
    const session = createJsonRedactionSession();

    expect(
      session.write({ type: "text_output", text: `before ${firstSecretFragment}` })
    ).toBeUndefined();
    expect(
      session.write({ type: "text_output", text: `${secondSecretFragment} after` })
    ).toBeUndefined();
    const results = session.finish();

    expect(results).toHaveLength(2);
    expect(results[0]?.value).toEqual({
      type: "text_output",
      text: `before [REDACTED:provider-openai:${firstSecretFragment.length}]`
    });
    expect(results[1]?.value).toEqual({
      type: "text_output",
      text: `[REDACTED:provider-openai:${secondSecretFragment.length}] after`
    });
    expect(results[0]?.manifest.matchCounts).toEqual({ "provider-openai": 1 });
    expect(results[1]?.manifest.matchCounts).toEqual({ "provider-openai": 1 });
    expect(results[0]?.manifest.applied[0]?.location).toBe("/text");
    expect(results[1]?.manifest.applied[0]?.location).toBe("/text");
  });

  it("prefers a complete cross-record provider match when its first fragment already matches", () => {
    const continuation = "CONTINUATION";
    const session = createJsonRedactionSession();
    session.write({ text: OPENAI_KEY });
    session.write({ text: continuation });

    const results = session.finish();
    expect(results[0]?.value).toEqual({
      text: `[REDACTED:provider-openai:${OPENAI_KEY.length}]`
    });
    expect(results[1]?.value).toEqual({
      text: `[REDACTED:provider-openai:${continuation.length}]`
    });
  });

  it("prefers a complete cross-record entropy match over a qualifying prefix", () => {
    const qualifyingPrefix = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const continuation = "YZ012";
    const session = createJsonRedactionSession();
    session.write({ text: qualifyingPrefix });
    session.write({ text: continuation });

    const results = session.finish();
    expect(results[0]?.value).toEqual({
      text: `[REDACTED:entropy:${qualifyingPrefix.length}]`
    });
    expect(results[1]?.value).toEqual({
      text: `[REDACTED:entropy:${continuation.length}]`
    });
  });

  it("does not let a local AWS-pattern hit expose an entropy continuation", () => {
    const continuation = "QRSTUVWX";
    const session = createJsonRedactionSession();
    session.write({ value: "AKIAABCDEFGHIJKLMNOP" });
    session.write({ value: continuation });

    const results = session.finish();
    expect(results[0]?.value).toEqual({ value: "[REDACTED:entropy:20]" });
    expect(results[1]?.value).toEqual({
      value: `[REDACTED:entropy:${continuation.length}]`
    });
  });

  it("detects a provider key split across different fields in adjacent records", () => {
    const firstSecretFragment = "sk-proj-SYNTHETIC0123";
    const secondSecretFragment = "456789abcdefghijklmnopqrstuv";
    const session = createJsonRedactionSession();
    session.write({ delta: firstSecretFragment });
    session.write({ result: secondSecretFragment });

    const results = session.finish();
    expect(results[0]?.value).toEqual({
      delta: `[REDACTED:provider-openai:${firstSecretFragment.length}]`
    });
    expect(results[1]?.value).toEqual({
      result: `[REDACTED:provider-openai:${secondSecretFragment.length}]`
    });
  });

  it("detects a provider key split across three changing record fields", () => {
    const session = createJsonRedactionSession();
    session.write({ type: "chunk", delta: "sk-proj-SYN" });
    session.write({ type: "chunk", content: "THETIC0123" });
    session.write({ type: "chunk", result: "456789abcdefghijklmnopqrstuv" });

    const results = session.finish();
    expect(results.map((result) => result.value)).toEqual([
      { type: "chunk", delta: "[REDACTED:provider-openai:11]" },
      { type: "chunk", content: "[REDACTED:provider-openai:10]" },
      { type: "chunk", result: "[REDACTED:provider-openai:28]" }
    ]);
  });

  it("uses explicit continuation pointers when payload ordinals drift", () => {
    const session = createJsonRedactionSession();
    session.write({ type: "chunk", delta: "sk-proj-" }, ["/delta"]);
    session.write(
      { type: "chunk", requestId: "stable-metadata", content: "AAAAAAAAAA" },
      ["/content"]
    );
    session.write(
      { type: "chunk", extra: "more-metadata", result: "AAAAAAAAAA" },
      ["/result"]
    );

    expect(session.finish().map((result) => result.value)).toEqual([
      { type: "chunk", delta: "[REDACTED:provider-openai:8]" },
      {
        type: "chunk",
        requestId: "stable-metadata",
        content: "[REDACTED:provider-openai:10]"
      },
      {
        type: "chunk",
        extra: "more-metadata",
        result: "[REDACTED:provider-openai:10]"
      }
    ]);
  });

  it.each([
    [["not-a-pointer"], "non-pointer"],
    [["/missing"], "missing"],
    [["/count"], "non-string"],
    [["/text", "/text"], "duplicate"]
  ])("fails closed for %s explicit continuation locations", (locations) => {
    const session = createJsonRedactionSession();
    expect(() =>
      session.write({ text: "safe", count: 1 }, locations)
    ).toThrowError(expect.objectContaining({ category: "redaction_failed" }));
    expect(() => session.finish()).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("redacts an entropy token split across adjacent string fields", () => {
    const firstFragment = "ABCDEFGH";
    const secondFragment = "IJKLMNOPQRST";
    const session = createJsonRedactionSession({ location: "/adapter_event" });
    session.write({ arguments: { first: firstFragment, second: secondFragment } });

    const [result] = session.finish();
    expect(result?.value).toEqual({
      arguments: {
        first: `[REDACTED:entropy:${firstFragment.length}]`,
        second: `[REDACTED:entropy:${secondFragment.length}]`
      }
    });
    expect(result?.manifest.applied.map((entry) => entry.location)).toEqual([
      "/adapter_event/arguments/first",
      "/adapter_event/arguments/second"
    ]);
  });

  it("preserves record order and runs ordinary deep redaction in the same pass", () => {
    const session = createJsonRedactionSession();
    session.write({ seq: 1, nested: { output: `${OPENAI_KEY} ` } });
    session.write({ seq: 2, nested: { output: "safe" } });

    const results = session.finish();
    expect(results.map((result) => result.value)).toEqual([
      { seq: 1, nested: { output: expect.stringContaining("[REDACTED:provider-openai:") } },
      { seq: 2, nested: { output: "safe" } }
    ]);
  });

  it("never retains a secret-bearing object key in a boundary manifest location", () => {
    const session = createJsonRedactionSession();
    session.write({ [OPENAI_KEY]: { value: OPENAI_KEY } });

    const [result] = session.finish();
    expect(JSON.stringify(result?.value)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(result?.manifest)).not.toContain(OPENAI_KEY);
    expect(result?.manifest.applied.every((entry) => entry.location === "" || entry.location.startsWith("/[REDACTED:"))).toBe(true);
  });

  it("fails closed when distinct secret keys map to the same replacement key", () => {
    const secondKey = `${OPENAI_KEY.slice(0, -1)}w`;
    const session = createJsonRedactionSession();
    session.write({ [OPENAI_KEY]: "first", [secondKey]: "second" });

    expect(() => session.finish()).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("fails closed and releases no result when the bounded record window overflows", () => {
    const session = createJsonRedactionSession({ maxInputBytes: 24 });
    session.write({ text: "short" });

    expect(() => session.write({ text: "this makes the window too large" })).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
    expect(() => session.finish()).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });
});
