import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalJsonBytes } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys by Unicode code point and preserves array order", () => {
    const value = {
      z: 0,
      "\u{10000}": 2,
      "\u{e000}": 1,
      a: [3, 2, 1],
      nested: { beta: true, alpha: null }
    };

    expect(canonicalJson(value)).toBe(
      '{"a":[3,2,1],"nested":{"alpha":null,"beta":true},"z":0,"":1,"𐀀":2}'
    );
  });

  it("emits exact UTF-8 bytes with no BOM, whitespace, or trailing newline", () => {
    const bytes = canonicalJsonBytes({ greeting: "héllo", line: "a\nb" });

    expect(bytes).toEqual(
      new TextEncoder().encode('{"greeting":"héllo","line":"a\\nb"}')
    );
    expect(bytes.at(0)).not.toBe(0xef);
    expect(bytes.at(-1)).not.toBe(0x0a);
  });

  it("renders signed safe integers without exponent notation and normalizes negative zero", () => {
    expect(canonicalJson({ max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER, zero: -0 })).toBe(
      '{"max":9007199254740991,"min":-9007199254740991,"zero":0}'
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["fraction", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["bigint", 1n]
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrowError(/invalid_invocation/u);
  });

  it("rejects invalid values at any depth rather than silently omitting them", () => {
    expect(() => canonicalJson({ nested: { missing: undefined } })).toThrowError(
      /invalid_invocation/u
    );
  });

  it("rejects cycles and unpaired UTF-16 surrogates", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrowError(/invalid_invocation/u);
    expect(() => canonicalJson("\ud800")).toThrowError(/invalid_invocation/u);
    expect(() => canonicalJson({ "\udc00": "invalid key" })).toThrowError(/invalid_invocation/u);
  });
});

