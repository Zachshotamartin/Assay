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

  it("enforces the exact serialized UTF-8 bound without a serialized copy", () => {
    const value = { escaped: 'quote=" slash=\\ newline=\n snowman=☃' };
    const byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(redactJsonDeep(value, { maxInputBytes: byteLength }).value).toEqual(value);
    expect(() => redactJsonDeep(value, { maxInputBytes: byteLength - 1 })).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("uses one immutable known-hash snapshot for every key and leaf", () => {
    const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const knownHashes = new Set([hash]);
    const result = redactJsonDeep(
      { first: hash, second: hash },
      {
        knownHashes,
        stageHook: () => knownHashes.clear()
      }
    );

    expect(result.value).toEqual({ first: hash, second: hash });
  });

  it("redacts structured AWS and GCP credential fields using their object-key context", () => {
    const awsSecret = "A".repeat(40);
    const privateKeyId = "a".repeat(40);
    const result = redactJsonDeep({
      SecretAccessKey: awsSecret,
      type: "service_account",
      client_secret: "plain-secret",
      private_key_id: privateKeyId
    });

    expect(result.value).toEqual({
      SecretAccessKey: "[REDACTED:aws-secret-access-key:40]",
      type: "[REDACTED:gcp-service-account:15]",
      client_secret: "[REDACTED:gcp-client-secret:12]",
      private_key_id: "[REDACTED:gcp-private-key-id:40]"
    });
    expect(result.manifest.matchCounts).toEqual({
      "aws-secret-access-key": 1,
      "gcp-client-secret": 1,
      "gcp-private-key-id": 1,
      "gcp-service-account": 1
    });
  });

  it("fails closed before a secret-bearing base location can enter a manifest", () => {
    let thrown: unknown;
    try {
      redactText("safe", { location: `/${OPENAI_KEY}` });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({ category: "redaction_failed" }));
    expect(JSON.stringify(thrown)).not.toContain(OPENAI_KEY);
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
