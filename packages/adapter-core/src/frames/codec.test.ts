import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  encodeAdapterEventFrame,
  parseAdapterEventFrame,
  parseAdapterEventFrameDetailed,
  parseAdapterHandshakeFrame,
  parseAdapterRunSpecFrame,
  serializeAdapterRunSpec
} from "./codec.js";
import { MAX_ADAPTER_STRING_BYTES } from "./line-splitter.js";

const fixtureRoot = new URL("../../../../fixtures/adapter-frames/", import.meta.url);

function fixture(group: "accept" | "reject", name: string): string {
  return readFileSync(new URL(`${group}/${name}`, fixtureRoot), "utf8").trimEnd();
}

const eventFixtures = [
  "session-started.json",
  "model-request.json",
  "model-response.json",
  "tool-call.json",
  "tool-result.json",
  "usage.json",
  "text-output.json",
  "text-output-truncated.json",
  "log.json",
  "run-completed.json",
  "run-failed.json"
] as const;

const requiredByEvent = {
  session_started: ["type", "seq", "ts", "session_id"],
  model_request: [
    "type", "seq", "ts", "request_id", "turn", "model", "message_count",
    "input_summary_sha256"
  ],
  model_response: [
    "type", "seq", "ts", "request_id", "status", "stop_reason", "latency_ms"
  ],
  tool_call: ["type", "seq", "ts", "call_id", "request_id", "tool", "args"],
  tool_result: ["type", "seq", "ts", "call_id", "status", "result", "duration_ms"],
  usage: [
    "type", "seq", "ts", "request_id", "prompt_tokens", "completion_tokens",
    "total_tokens", "source"
  ],
  text_output: ["type", "seq", "ts", "text"],
  log: ["type", "seq", "ts", "level", "message"],
  run_completed: ["type", "seq", "ts", "summary"],
  run_failed: ["type", "seq", "ts", "category", "message"]
} as const;

function expectCategory(run: () => unknown, category: string): void {
  expect(run).toThrow(expect.objectContaining({ category }));
}

describe("assay-adapter/1 event frames", () => {
  it.each(eventFixtures)("round-trips %s through the public AdapterEvent union", (name) => {
    const raw = fixture("accept", name);
    const parsed = parseAdapterEventFrame(raw);
    const encoded = encodeAdapterEventFrame(parsed);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(parseAdapterEventFrame(encoded.slice(0, -1))).toEqual(parsed);
  });

  it.each(eventFixtures)("rejects an unknown property on %s", (name) => {
    const value = JSON.parse(fixture("accept", name)) as Record<string, unknown>;
    value["unknown"] = true;
    expectCategory(() => parseAdapterEventFrame(JSON.stringify(value)), "adapter_protocol_error");
  });

  it("rejects every missing required field on every event variant", () => {
    for (const name of eventFixtures) {
      const value = JSON.parse(fixture("accept", name)) as Record<string, unknown>;
      const required = requiredByEvent[value["type"] as keyof typeof requiredByEvent];
      for (const field of required) {
        const candidate = { ...value };
        delete candidate[field];
        expectCategory(
          () => parseAdapterEventFrame(JSON.stringify(candidate)),
          "adapter_protocol_error"
        );
      }
    }
  });

  it("rejects unknown frame types, imprecise timestamps, and inconsistent usage", () => {
    for (const name of [
      "event-unknown-type.json",
      "event-unknown-field.json",
      "event-imprecise-timestamp.json",
      "usage-arithmetic.json"
    ]) {
      expectCategory(
        () => parseAdapterEventFrame(fixture("reject", name)),
        "adapter_protocol_error"
      );
    }
  });

  it("requires synthetic usage to report an explicit zero micro-USD cost", () => {
    const value = JSON.parse(fixture("accept", "usage.json")) as Record<string, unknown>;
    delete value["cost_usd_micros"];
    expectCategory(() => parseAdapterEventFrame(JSON.stringify(value)), "adapter_protocol_error");
    expectCategory(
      () => parseAdapterEventFrame(JSON.stringify({ ...value, cost_usd_micros: 1 })),
      "adapter_protocol_error"
    );
  });

  it("maps the exact Architecture section 6 snake_case frames to frozen camelCase types", () => {
    expect(parseAdapterEventFrame(fixture("accept", "model-request.json"))).toMatchObject({
      type: "model_request",
      requestId: "request-1",
      messageCount: 1,
      inputSummarySha256: "0".repeat(64)
    });
    expect(parseAdapterEventFrame(fixture("accept", "usage.json"))).toMatchObject({
      type: "usage",
      usage: {
        requestId: "request-1",
        promptTokens: 8,
        completionTokens: 5,
        totalTokens: 13,
        costUsdMicros: 0,
        source: "synthetic"
      }
    });
  });

  it("round-trips explicit truncation metadata and rejects incomplete metadata", () => {
    expect(parseAdapterEventFrame(fixture("accept", "text-output-truncated.json"))).toMatchObject({
      type: "text_output",
      truncated: true,
      originalSha256: "a".repeat(64)
    });
    expectCategory(
      () => parseAdapterEventFrame(fixture("reject", "truncation-incomplete.json")),
      "adapter_protocol_error"
    );
  });

  it.each([
    ["model-response.json", "text"],
    ["tool-result.json", "result"],
    ["text-output.json", "text"],
    ["run-completed.json", "summary"],
    ["run-failed.json", "message"],
    ["log.json", "message"]
  ] as const)("publishes paired truncation metadata for %s", (name, payloadField) => {
    const value = JSON.parse(fixture("accept", name)) as Record<string, unknown>;
    expect(typeof value[payloadField]).toBe("string");
    value["truncated"] = true;
    value["original_sha256"] = "b".repeat(64);
    const parsed = parseAdapterEventFrame(JSON.stringify(value));
    expect(parsed).toMatchObject({ truncated: true, originalSha256: "b".repeat(64) });
    expect(parseAdapterEventFrame(encodeAdapterEventFrame(parsed).slice(0, -1))).toEqual(parsed);
  });

  it("rejects truncation metadata on non-payload frame variants", () => {
    const value = JSON.parse(fixture("accept", "session-started.json")) as Record<string, unknown>;
    value["truncated"] = true;
    value["original_sha256"] = "b".repeat(64);
    expectCategory(() => parseAdapterEventFrame(JSON.stringify(value)), "adapter_protocol_error");
  });

  it("measures the universal string limit in UTF-8 bytes and defensively truncates payloads", () => {
    const exactlyBounded = "é".repeat(MAX_ADAPTER_STRING_BYTES / 2);
    expect(parseAdapterEventFrame(JSON.stringify({
      type: "text_output", seq: 2, ts: "2026-01-02T03:04:05.006Z", text: exactlyBounded
    }))).toMatchObject({ text: exactlyBounded });

    const overlong = `${exactlyBounded}é`;
    const parsed = parseAdapterEventFrameDetailed(JSON.stringify({
      type: "text_output", seq: 2, ts: "2026-01-02T03:04:05.006Z", text: overlong
    }));
    expect(encoderByteLength((parsed.event as { text: string }).text))
      .toBe(MAX_ADAPTER_STRING_BYTES);
    expect(parsed.event).toMatchObject({
      truncated: true,
      originalSha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(parsed.defensiveTruncations).toEqual([
      expect.objectContaining({ path: "$.text", originalBytes: MAX_ADAPTER_STRING_BYTES + 2 })
    ]);
  });

  it("rejects overlong identity strings instead of corrupting pairing keys", () => {
    const value = JSON.parse(fixture("accept", "model-request.json")) as Record<string, unknown>;
    value["request_id"] = "r".repeat(MAX_ADAPTER_STRING_BYTES + 1);
    expectCategory(() => parseAdapterEventFrame(JSON.stringify(value)), "adapter_protocol_error");
  });

  it("keeps every accepted and rejected fixture as an individual JSON document", async () => {
    for (const group of ["accept", "reject"] as const) {
      const names = await readdir(new URL(`${group}/`, fixtureRoot));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(() => JSON.parse(fixture(group, name))).not.toThrow();
      }
    }
  });
});

function encoderByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe("assay-adapter/1 handshake negotiation", () => {
  it.each(["handshake-full.json", "handshake-trajectory.json", "handshake-black-box.json"])(
    "accepts and normalizes %s",
    (name) => {
      const handshake = parseAdapterHandshakeFrame(fixture("accept", name));
      expect(handshake).toMatchObject({
        type: "handshake",
        seq: 1,
        descriptor: { contractVersion: "assay-adapter/1" }
      });
    }
  );

  it("rejects an unknown contract major as adapter_nonconformant", () => {
    expectCategory(
      () => parseAdapterHandshakeFrame(fixture("reject", "handshake-unknown-major.json")),
      "adapter_nonconformant"
    );
  });

  it("rejects the superseded AGENT_COMPATIBILITY draft shape", () => {
    expectCategory(
      () => parseAdapterHandshakeFrame(fixture("reject", "handshake-draft-shape.json")),
      "adapter_protocol_error"
    );
  });

  it("rejects duplicate tool names and unknown capability keys", () => {
    expectCategory(
      () => parseAdapterHandshakeFrame(fixture("reject", "handshake-duplicate-tool.json")),
      "adapter_protocol_error"
    );
    const value = JSON.parse(fixture("accept", "handshake-full.json")) as Record<string, unknown>;
    value["capabilities"] = {
      ...(value["capabilities"] as Record<string, unknown>),
      future_capability: true
    };
    expectCategory(
      () => parseAdapterHandshakeFrame(JSON.stringify(value)),
      "adapter_protocol_error"
    );
  });

  it("enforces SemVer, including numeric prerelease leading-zero rejection", () => {
    expectCategory(
      () => parseAdapterHandshakeFrame(fixture("reject", "handshake-invalid-semver.json")),
      "adapter_protocol_error"
    );
  });

  it("requires model and tool_catalog for full and trajectory tiers", () => {
    for (const field of ["model", "tool_catalog"] as const) {
      const value = JSON.parse(fixture("accept", "handshake-full.json")) as Record<string, unknown>;
      delete value[field];
      expectCategory(
        () => parseAdapterHandshakeFrame(JSON.stringify(value)),
        "adapter_protocol_error"
      );
    }
  });
});

describe("assay-adapter/1 run specification", () => {
  it("parses and serializes exactly one strict JSONL line", () => {
    const raw = fixture("accept", "run-spec.json");
    const spec = parseAdapterRunSpecFrame(raw);
    const encoded = serializeAdapterRunSpec(spec);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded).toBe(`${JSON.stringify(JSON.parse(raw))}\n`);
    expect(parseAdapterRunSpecFrame(encoded.slice(0, -1))).toEqual(spec);
  });

  it("rejects unknown fields and a non-string seed", () => {
    const value = JSON.parse(fixture("accept", "run-spec.json")) as Record<string, unknown>;
    expectCategory(
      () => parseAdapterRunSpecFrame(JSON.stringify({ ...value, unknown: true })),
      "adapter_protocol_error"
    );
    expectCategory(
      () => parseAdapterRunSpecFrame(JSON.stringify({ ...value, seed: 42 })),
      "adapter_protocol_error"
    );
    expectCategory(
      () => parseAdapterRunSpecFrame(JSON.stringify({ ...value, task_id: "INVALID" })),
      "adapter_protocol_error"
    );
  });
});
