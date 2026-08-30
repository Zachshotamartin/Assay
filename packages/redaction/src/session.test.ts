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
    session.write({ seq: 1, nested: { output: OPENAI_KEY } });
    session.write({ seq: 2, nested: { output: "safe" } });

    const results = session.finish();
    expect(results.map((result) => result.value)).toEqual([
      { seq: 1, nested: { output: expect.stringContaining("[REDACTED:provider-openai:") } },
      { seq: 2, nested: { output: "safe" } }
    ]);
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
