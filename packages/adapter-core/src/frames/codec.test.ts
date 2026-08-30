import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  encodeAdapterEventFrame,
  parseAdapterEventFrame,
  parseAdapterHandshakeFrame,
  parseAdapterRunSpecFrame,
  serializeAdapterRunSpec
} from "./codec.js";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

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
    "type", "seq", "ts", "request_id", "status", "stop_reason", "latency_ms", "text"
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
  });
});
