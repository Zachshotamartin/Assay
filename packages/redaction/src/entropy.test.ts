import { afterEach, describe, expect, it, vi } from "vitest";

import { redactText, shannonEntropyBitsPerCharacter } from "./index.js";

const BASE64_AT_THRESHOLD = "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP";
const BASE64_AT_MINIMUM_LENGTH = "ABCDEFGHIJKLMNOPQRST";
const HEX_AT_THRESHOLD = "012345670123456701234567";
const CONTENT_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("entropy redaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Shannon entropy in bits per character", () => {
    expect(shannonEntropyBitsPerCharacter(BASE64_AT_THRESHOLD)).toBeCloseTo(4, 12);
    expect(shannonEntropyBitsPerCharacter(HEX_AT_THRESHOLD)).toBeCloseTo(3, 12);
    expect(shannonEntropyBitsPerCharacter("AAAAAAAAAAAAAAAAAAAA")).toBe(0);
  });

  it("redacts base64/base64url candidates of at least 20 characters at 4.0 bits/char", () => {
    const result = redactText(BASE64_AT_THRESHOLD);

    expect(result.value).toBe(`[REDACTED:entropy:${BASE64_AT_THRESHOLD.length}]`);
    expect(result.manifest.matchCounts).toEqual({ entropy: 1 });
    expect(redactText(BASE64_AT_MINIMUM_LENGTH).value).toBe(
      `[REDACTED:entropy:${BASE64_AT_MINIMUM_LENGTH.length}]`
    );
  });

  it("redacts hexadecimal candidates at 3.0 bits/char", () => {
    const result = redactText(HEX_AT_THRESHOLD);

    expect(result.value).toBe(`[REDACTED:entropy:${HEX_AT_THRESHOLD.length}]`);
  });

  it("does not redact low-entropy candidates", () => {
    const lowEntropy = "AAAAABAAAAABAAAAABAAAAAB";
    expect(redactText(lowEntropy).value).toBe(lowEntropy);
  });

  it("exempts only an exact candidate present in the injected run hash set", () => {
    const knownHashes = new Set([CONTENT_HASH]);

    expect(redactText(CONTENT_HASH, { knownHashes }).value).toBe(CONTENT_HASH);
    expect(redactText(`${CONTENT_HASH}a`, { knownHashes }).value).toBe(
      `[REDACTED:entropy:${CONTENT_HASH.length + 1}]`
    );
  });

  it("snapshots the injected native set before detector hooks can mutate it", () => {
    const knownHashes = new Set([CONTENT_HASH]);
    const result = redactText(CONTENT_HASH, {
      knownHashes,
      stageHook: () => knownHashes.clear()
    });

    expect(result.value).toBe(CONTENT_HASH);
  });

  it("rejects predicate objects that could exempt arbitrary entropy candidates", () => {
    const forgedSet = { has: () => true } as unknown as ReadonlySet<string>;
    expect(() => redactText(CONTENT_HASH, { knownHashes: forgedSet })).toThrowError(
      expect.objectContaining({ category: "redaction_failed" })
    );
  });

  it("never reads ambient environment variables as hash exemptions", () => {
    vi.stubEnv("ASSAY_KNOWN_CONTENT_HASHES", CONTENT_HASH);

    expect(redactText(CONTENT_HASH).value).toBe(`[REDACTED:entropy:${CONTENT_HASH.length}]`);
  });
});
