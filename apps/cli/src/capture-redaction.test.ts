import type { AdapterEvent } from "@assay/adapter-core";
import { describe, expect, it } from "vitest";

import {
  adapterContinuationLocations,
  redactAdapterEventBatch
} from "./run-command.js";

const ts = "2000-01-01T00:00:00.000Z";

const variants = [
  { type: "session_started", seq: 2, ts, sessionId: "session" },
  {
    type: "model_request",
    seq: 3,
    ts,
    requestId: "request",
    turn: 0,
    model: { provider: "synthetic", model: "scripted-v1", family: "synthetic" },
    messageCount: 1,
    inputSummarySha256: "0".repeat(64)
  },
  {
    type: "model_response",
    seq: 4,
    ts,
    requestId: "request",
    status: "ok",
    stopReason: "tool_use",
    latencyMs: 1,
    text: "subject text"
  },
  {
    type: "tool_call",
    seq: 5,
    ts,
    callId: "call",
    requestId: "request",
    tool: "write_file",
    args: { path: "src/value.ts", nested: { content: "subject code" }, count: 1 }
  },
  { type: "tool_result", seq: 6, ts, callId: "call", status: "ok", result: "tool text", durationMs: 1 },
  {
    type: "usage",
    seq: 7,
    ts,
    usage: {
      requestId: "request",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      costUsdMicros: 0,
      source: "synthetic"
    }
  },
  { type: "text_output", seq: 8, ts, text: "subject output" },
  { type: "run_completed", seq: 9, ts, summary: "subject summary" },
  {
    type: "run_failed",
    seq: 10,
    ts,
    category: "agent_gave_up",
    message: "subject failure"
  },
  { type: "log", seq: 11, ts, level: "info", message: "subject log" }
] as const satisfies readonly AdapterEvent[];

describe("R1 capture-boundary semantic continuations", () => {
  it("maps every frozen adapter event variant without joining discriminator metadata", () => {
    expect(variants.map((event) => [event.type, adapterContinuationLocations(event)] as const)).toEqual([
      ["session_started", []],
      ["model_request", []],
      ["model_response", ["/text"]],
      ["tool_call", ["/args/nested/content", "/args/path"]],
      ["tool_result", ["/result"]],
      ["usage", []],
      ["text_output", ["/text"]],
      ["run_completed", ["/summary"]],
      ["run_failed", ["/message"]],
      ["log", ["/message"]]
    ]);
  });

  it("redacts a provider key split across three changing event variants and fields", () => {
    const fragments = [
      "sk-proj-SYN",
      "THETIC0123456789abc",
      "defghijklmnopqrstuv"
    ] as const;
    const events: readonly AdapterEvent[] = [
      { type: "text_output", seq: 2, ts, text: fragments[0] },
      {
        type: "tool_result",
        seq: 3,
        ts,
        callId: "call",
        status: "ok",
        result: fragments[1],
        durationMs: 1
      },
      { type: "run_completed", seq: 4, ts, summary: fragments[2] }
    ];

    const redacted = redactAdapterEventBatch(events, new Set()).events;
    const serialized = JSON.stringify(redacted);

    for (const fragment of fragments) expect(serialized).not.toContain(fragment);
    expect(serialized).toContain("[REDACTED:provider-openai:");
  });

  it("records persisted event pointers once without projection-only locations", () => {
    const secret = "sk-proj-SYNTHETIC0123456789abcdefghijklmnopqrstuv";
    const result = redactAdapterEventBatch([
      { type: "text_output", seq: 2, ts, text: secret }
    ], new Set());

    expect(result.events[0]).toMatchObject({ text: expect.stringContaining("[REDACTED:provider-openai:") });
    expect(result.manifests[0]!.redactionCount).toBe(1);
    expect(result.manifests[0]!.applied).toEqual([
      expect.objectContaining({
        ruleId: "provider-openai",
        location: "/trajectory/events/0/text",
        count: 1
      })
    ]);
    expect(JSON.stringify(result.manifests)).not.toContain("/trajectory/subjects");
  });
});
