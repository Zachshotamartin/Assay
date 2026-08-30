import { describe, expect, it } from "vitest";

import {
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
