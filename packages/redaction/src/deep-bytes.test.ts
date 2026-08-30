import { describe, expect, it } from "vitest";

import { AssayError } from "@assay/contracts";

import {
  redactJsonDeep,
  redactText,
  redactUtf8Bytes,
  type RedactionStage
} from "./index.js";

const OPENAI_KEY = "sk-proj-SYNTHETIC0123456789abcdefghijklmnopqrstuv";

describe("deep JSON redaction", () => {
  it("redacts every string leaf without mutating input and emits RFC 6901 locations", () => {
    const input = {
      "tool/output": {
        nested: [`value=${OPENAI_KEY}`]
      },
      "til~de": `diagnostic=${OPENAI_KEY}`,
      safe: 7
    };

    const result = redactJsonDeep(input);

    expect(input["tool/output"].nested[0]).toContain(OPENAI_KEY);
    expect(result.value).toEqual({
      "tool/output": {
        nested: [expect.stringContaining("[REDACTED:provider-openai:")]
      },
      "til~de": expect.stringContaining("[REDACTED:provider-openai:"),
      safe: 7
    });
    expect(result.manifest.applied.map((entry) => entry.location)).toEqual([
      "/tool~1output/nested/0",
      "/til~0de"
    ]);
  });

  it("composes an injected base JSON-pointer location", () => {
    const result = redactJsonDeep({ output: OPENAI_KEY }, { location: "/adapter_event" });
    expect(result.manifest.applied[0]?.location).toBe("/adapter_event/output");
  });

  it.each([
    undefined,
    1n,
    Number.NaN,
    () => "not JSON"
  ])("fails closed for non-JSON values", (value) => {
    expect(() => redactJsonDeep(value)).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("fails closed for cyclic values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => redactJsonDeep(cyclic)).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });
});

describe("strict UTF-8 and fail-closed behavior", () => {
  it("redacts valid UTF-8 bytes and returns UTF-8 bytes", () => {
    const input = new TextEncoder().encode(`adapter=${OPENAI_KEY}`);
    const result = redactUtf8Bytes(input, { location: "/adapter_event" });
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.value);

    expect(output).not.toContain(OPENAI_KEY);
    expect(output).toContain("[REDACTED:provider-openai:");
  });

  it("preserves a UTF-8 byte-order mark in otherwise safe bytes", () => {
    const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x73, 0x61, 0x66, 0x65]);
    expect(redactUtf8Bytes(input).value).toEqual(input);
  });

  it("rejects malformed UTF-8 instead of passing bytes through", () => {
    const malformed = new Uint8Array([0xc3, 0x28]);
    expect(() => redactUtf8Bytes(malformed)).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("rejects records over the configured input bound before scanning", () => {
    expect(() => redactText("123456", { maxInputBytes: 5 })).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("bounds byte records before decoding or invoking a detector", () => {
    let detectorCalled = false;
    expect(() =>
      redactUtf8Bytes(new TextEncoder().encode("123456"), {
        maxInputBytes: 5,
        stageHook: () => {
          detectorCalled = true;
        }
      })
    ).toThrowError(expect.objectContaining({ category: "redaction_failed" }));
    expect(detectorCalled).toBe(false);
  });

  it("converts detector failures to a stable redaction_failed error without leaking text", () => {
    const canary = `must-not-escape-${OPENAI_KEY}`;
    const stageHook = (_stage: RedactionStage): void => {
      throw new Error(canary);
    };

    let thrown: unknown;
    try {
      redactText(`payload=${OPENAI_KEY}`, { stageHook });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AssayError);
    expect(thrown).toEqual(expect.objectContaining({ category: "redaction_failed" }));
    expect(String(thrown)).not.toContain(canary);
    expect(JSON.stringify(thrown)).not.toContain(OPENAI_KEY);
  });
});
