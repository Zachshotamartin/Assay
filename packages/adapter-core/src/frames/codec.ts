import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  AssayError,
  createTaskId,
  createTaskRunId
} from "@assay/contracts";

import eventSchema from "../../schemas/adapter-event.v1.schema.json" with { type: "json" };
import handshakeSchema from "../../schemas/handshake.v1.schema.json" with { type: "json" };
import runSpecSchema from "../../schemas/run-spec.v1.schema.json" with { type: "json" };
import { assertSupportedAdapterContract } from "../negotiation.js";
import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterEvent,
  type AdapterHandshake,
  type AdapterRunSpec,
  type ModelIdentity,
  type ToolCatalogEntry
} from "../types.js";

type JsonObject = Record<string, unknown>;

interface HandshakeWire {
  readonly type: "handshake";
  readonly seq: 1;
  readonly contract: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly tier: "full" | "trajectory" | "black_box";
  readonly model?: ModelIdentity | null;
  readonly tool_catalog?: readonly {
    readonly name: string;
    readonly semantic_class: "read" | "write" | "execute";
  }[];
  readonly capabilities: Readonly<Record<string, boolean>>;
}

interface RunSpecWire {
  readonly type: "run_spec";
  readonly contract: typeof ADAPTER_CONTRACT_VERSION;
  readonly task_id: string;
  readonly task_run_id: string;
  readonly prompt: string;
  readonly workspace_path: string;
  readonly seed: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: { readonly wall_clock_ms: number };
  readonly budgets_advisory: {
    readonly total_tokens?: number;
    readonly tool_calls?: number;
    readonly usd_micros?: number;
  };
}

interface EventWire extends JsonObject {
  readonly type: AdapterEvent["type"];
  readonly seq: number;
  readonly ts: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validateHandshake = ajv.compile(handshakeSchema) as ValidateFunction<HandshakeWire>;
const validateRunSpec = ajv.compile(runSpecSchema) as ValidateFunction<RunSpecWire>;
const validateEvent = ajv.compile(eventSchema) as ValidateFunction<EventWire>;

function protocolError(message: string, cause?: unknown): never {
  throw new AssayError(
    "adapter_protocol_error",
    `adapter_protocol_error: ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function parseJsonObject(input: string): JsonObject {
  let candidate: unknown;
  try {
    candidate = JSON.parse(input) as unknown;
  } catch (cause) {
    return protocolError("frame is not valid JSON", cause);
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return protocolError("frame must be one JSON object");
  }
  return candidate as JsonObject;
}

function failedSchema(kind: string, validator: ValidateFunction<unknown>): never {
  const first = validator.errors?.[0];
  const path = first?.instancePath === "" ? "$" : (first?.instancePath ?? "$unknown");
  return protocolError(`${kind} failed schema at ${path} (${first?.keyword ?? "schema"})`);
}

function exactTimestamp(timestamp: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
    return false;
  }
  const parsed = new Date(timestamp);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === timestamp;
}

function toolCatalog(wire: HandshakeWire): readonly ToolCatalogEntry[] {
  const entries = wire.tool_catalog ?? [];
  const names = new Set<string>();
  return entries.map((entry) => {
    if (names.has(entry.name)) {
      return protocolError(`handshake tool_catalog contains duplicate name ${JSON.stringify(entry.name)}`);
    }
    names.add(entry.name);
    return { name: entry.name, semanticClass: entry.semantic_class };
  });
}

export function parseAdapterHandshakeFrame(input: string): AdapterHandshake {
  const candidate = parseJsonObject(input);
  const contract = candidate["contract"];
  if (typeof contract === "string" && /^assay-adapter\/(0|[1-9][0-9]*)$/u.test(contract)) {
    assertSupportedAdapterContract(contract);
  }
  if (!validateHandshake(candidate)) {
    return failedSchema("handshake", validateHandshake);
  }
  const contractVersion = assertSupportedAdapterContract(candidate.contract);
  return {
    type: "handshake",
    seq: 1,
    descriptor: {
      id: candidate.adapter.id,
      version: candidate.adapter.version,
      contractVersion,
      tier: candidate.tier,
      model: candidate.model ?? null,
      toolCatalog: toolCatalog(candidate),
      capabilities: { ...candidate.capabilities }
    }
  };
}

export function parseAdapterRunSpecFrame(input: string): AdapterRunSpec {
  const candidate = parseJsonObject(input);
  if (!validateRunSpec(candidate)) {
    return failedSchema("run specification", validateRunSpec);
  }
  let taskId: AdapterRunSpec["taskId"];
  let taskRunId: AdapterRunSpec["taskRunId"];
  try {
    taskId = createTaskId(candidate.task_id);
    taskRunId = createTaskRunId(candidate.task_run_id);
  } catch (cause) {
    return protocolError("run specification contains an invalid task identifier", cause);
  }
  return {
    taskId,
    taskRunId,
    prompt: candidate.prompt,
    workspacePath: candidate.workspace_path,
    seed: candidate.seed,
    env: { ...candidate.env },
    limits: { wallClockMs: candidate.limits.wall_clock_ms },
    budgetsAdvisory: {
      ...(candidate.budgets_advisory.total_tokens === undefined
        ? {}
        : { totalTokens: candidate.budgets_advisory.total_tokens }),
      ...(candidate.budgets_advisory.tool_calls === undefined
        ? {}
        : { toolCalls: candidate.budgets_advisory.tool_calls }),
      ...(candidate.budgets_advisory.usd_micros === undefined
        ? {}
        : { usdMicros: candidate.budgets_advisory.usd_micros })
    }
  };
}

function toRunSpecWire(spec: AdapterRunSpec): RunSpecWire {
  return {
    type: "run_spec",
    contract: ADAPTER_CONTRACT_VERSION,
    task_id: spec.taskId,
    task_run_id: spec.taskRunId,
    prompt: spec.prompt,
    workspace_path: spec.workspacePath,
    seed: spec.seed,
    env: spec.env,
    limits: { wall_clock_ms: spec.limits.wallClockMs },
    budgets_advisory: {
      ...(spec.budgetsAdvisory.totalTokens === undefined
        ? {}
        : { total_tokens: spec.budgetsAdvisory.totalTokens }),
      ...(spec.budgetsAdvisory.toolCalls === undefined
        ? {}
        : { tool_calls: spec.budgetsAdvisory.toolCalls }),
      ...(spec.budgetsAdvisory.usdMicros === undefined
        ? {}
        : { usd_micros: spec.budgetsAdvisory.usdMicros })
    }
  };
}

export function serializeAdapterRunSpec(spec: AdapterRunSpec): string {
  const wire = toRunSpecWire(spec);
  if (!validateRunSpec(wire)) {
    return failedSchema("run specification", validateRunSpec);
  }
  return `${JSON.stringify(wire)}\n`;
}

function modelFromWire(value: unknown): ModelIdentity {
  return value as ModelIdentity;
}

export function parseAdapterEventFrame(input: string): AdapterEvent {
  const candidate = parseJsonObject(input);
  if (!validateEvent(candidate)) {
    return failedSchema("adapter event", validateEvent);
  }
  if (!exactTimestamp(candidate.ts)) {
    return protocolError("adapter event timestamp must be exact RFC 3339 UTC milliseconds");
  }

  switch (candidate.type) {
    case "session_started":
      return { type: candidate.type, seq: candidate.seq, ts: candidate.ts, sessionId: candidate["session_id"] as string };
    case "model_request":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        requestId: candidate["request_id"] as string,
        turn: candidate["turn"] as number,
        model: modelFromWire(candidate["model"]),
        messageCount: candidate["message_count"] as number,
        inputSummarySha256: candidate["input_summary_sha256"] as string
      };
    case "model_response":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        requestId: candidate["request_id"] as string,
        status: candidate["status"] as "ok" | "provider_error" | "timeout",
        stopReason: (candidate["stop_reason"] ?? null) as
          | "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other" | null,
        latencyMs: candidate["latency_ms"] as number,
        text: (candidate["text"] ?? null) as string | null
      };
    case "tool_call":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        callId: candidate["call_id"] as string,
        requestId: candidate["request_id"] as string,
        tool: candidate["tool"] as string,
        args: candidate["args"] as Readonly<Record<string, unknown>>
      };
    case "tool_result":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        callId: candidate["call_id"] as string,
        status: candidate["status"] as "ok" | "error" | "timeout",
        result: candidate["result"] as string,
        durationMs: candidate["duration_ms"] as number
      };
    case "usage": {
      const promptTokens = candidate["prompt_tokens"] as number;
      const completionTokens = candidate["completion_tokens"] as number;
      const totalTokens = candidate["total_tokens"] as number;
      if (totalTokens !== promptTokens + completionTokens) {
        return protocolError("usage total_tokens must equal prompt_tokens plus completion_tokens");
      }
      const source = candidate["source"] as "provider" | "synthetic";
      const costUsdMicros = (candidate["cost_usd_micros"] ?? null) as number | null;
      if (source === "synthetic" && costUsdMicros !== null && costUsdMicros !== 0) {
        return protocolError("synthetic usage must report zero cost");
      }
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        usage: {
          requestId: candidate["request_id"] as string,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsdMicros,
          source
        }
      };
    }
    case "text_output":
      return { type: candidate.type, seq: candidate.seq, ts: candidate.ts, text: candidate["text"] as string };
    case "run_completed":
      return { type: candidate.type, seq: candidate.seq, ts: candidate.ts, summary: candidate["summary"] as string };
    case "run_failed":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        category: candidate["category"] as "agent_gave_up" | "agent_crashed" | "provider_error" | "internal",
        message: candidate["message"] as string
      };
    case "log":
      return {
        type: candidate.type,
        seq: candidate.seq,
        ts: candidate.ts,
        level: candidate["level"] as "debug" | "info" | "warn" | "error",
        message: candidate["message"] as string
      };
  }
}

function toEventWire(event: AdapterEvent): JsonObject {
  const base = { type: event.type, seq: event.seq, ts: event.ts };
  switch (event.type) {
    case "session_started":
      return { ...base, session_id: event.sessionId };
    case "model_request":
      return {
        ...base,
        request_id: event.requestId,
        turn: event.turn,
        model: event.model,
        message_count: event.messageCount,
        input_summary_sha256: event.inputSummarySha256
      };
    case "model_response":
      return {
        ...base,
        request_id: event.requestId,
        status: event.status,
        stop_reason: event.stopReason,
        latency_ms: event.latencyMs,
        text: event.text
      };
    case "tool_call":
      return { ...base, call_id: event.callId, request_id: event.requestId, tool: event.tool, args: event.args };
    case "tool_result":
      return { ...base, call_id: event.callId, status: event.status, result: event.result, duration_ms: event.durationMs };
    case "usage":
      return {
        ...base,
        request_id: event.usage.requestId,
        prompt_tokens: event.usage.promptTokens,
        completion_tokens: event.usage.completionTokens,
        total_tokens: event.usage.totalTokens,
        ...(event.usage.costUsdMicros === null ? {} : { cost_usd_micros: event.usage.costUsdMicros }),
        source: event.usage.source
      };
    case "text_output":
      return { ...base, text: event.text };
    case "run_completed":
      return { ...base, summary: event.summary };
    case "run_failed":
      return { ...base, category: event.category, message: event.message };
    case "log":
      return { ...base, level: event.level, message: event.message };
  }
}

export function encodeAdapterEventFrame(event: AdapterEvent): string {
  const wire = toEventWire(event);
  if (!validateEvent(wire)) {
    return failedSchema("adapter event", validateEvent);
  }
  const serialized = JSON.stringify(wire);
  parseAdapterEventFrame(serialized);
  return `${serialized}\n`;
}
