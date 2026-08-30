import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";

import {
  encodeAdapterEventFrame,
  MAX_ADAPTER_FRAME_BYTES,
  type AdapterEvent,
  type AdapterRunSpec
} from "@assay/adapter-core";

type AdapterEventPayload = AdapterEvent extends infer Event
  ? Event extends AdapterEvent
    ? Omit<Event, "seq" | "ts">
    : never
  : never;

export type SimulatedMisbehavior =
  | "malformed_json"
  | "garbage_stdout"
  | "invalid_utf8"
  | "oversized_frame"
  | "sequence_gap"
  | "post_terminal_frame"
  | "missing_tool_result"
  | "usage_arithmetic_error"
  | "exit_zero_without_terminal"
  | "crash_at_step"
  | "early_exit"
  | "frame_flood"
  | "hang_until_timeout"
  | "ignore_sigterm";

export type SimulatedStep =
  | { readonly emit: AdapterEventPayload }
  | { readonly sleep_ms: number }
  | { readonly write_file: { readonly path: string; readonly contents: string } }
  | { readonly delete_file: { readonly path: string } }
  | { readonly misbehave: SimulatedMisbehavior };

export interface SimulatedScenario {
  readonly scenario_version: 1;
  readonly steps: readonly SimulatedStep[];
}

export interface SimulatedClock {
  timestamp(): string;
  sleep(milliseconds: number): Promise<void>;
}

export type SimulatedAction =
  | { readonly kind: "stdout"; readonly bytes: Uint8Array }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "hang"; readonly ignoreSigterm: boolean };

export interface ExecuteSimulatedScenarioOptions {
  readonly clock?: SimulatedClock;
}

const encoder = new TextEncoder();
const EVENT_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const MISBEHAVIORS = new Set<SimulatedMisbehavior>([
  "malformed_json",
  "garbage_stdout",
  "invalid_utf8",
  "oversized_frame",
  "sequence_gap",
  "post_terminal_frame",
  "missing_tool_result",
  "usage_arithmetic_error",
  "exit_zero_without_terminal",
  "crash_at_step",
  "early_exit",
  "frame_flood",
  "hang_until_timeout",
  "ignore_sigterm"
]);

const EVENT_KEYS: Readonly<Record<AdapterEvent["type"], {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}>> = {
  session_started: { required: ["type", "sessionId"] },
  model_request: {
    required: [
      "type", "requestId", "turn", "model", "messageCount", "inputSummarySha256"
    ]
  },
  model_response: {
    required: ["type", "requestId", "status", "stopReason", "latencyMs", "text"],
    optional: ["truncated", "originalSha256"]
  },
  tool_call: { required: ["type", "callId", "requestId", "tool", "args"] },
  tool_result: {
    required: ["type", "callId", "status", "result", "durationMs"],
    optional: ["truncated", "originalSha256"]
  },
  usage: { required: ["type", "usage"] },
  text_output: {
    required: ["type", "text"],
    optional: ["truncated", "originalSha256"]
  },
  run_completed: {
    required: ["type", "summary"],
    optional: ["truncated", "originalSha256"]
  },
  run_failed: {
    required: ["type", "category", "message"],
    optional: ["truncated", "originalSha256"]
  },
  log: {
    required: ["type", "level", "message"],
    optional: ["truncated", "originalSha256"]
  }
};

class DeterministicClock implements SimulatedClock {
  #milliseconds = Date.parse(EVENT_TIMESTAMP);

  timestamp(): string {
    const timestamp = new Date(this.#milliseconds).toISOString();
    this.#milliseconds += 1;
    return timestamp;
  }

  async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

function scenarioError(message: string, cause?: unknown): never {
  throw new Error(
    `simulated scenario invalid: ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return scenarioError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) scenarioError(`${path} has unknown key ${JSON.stringify(unknown)}`);
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) scenarioError(`${path} is missing ${JSON.stringify(missing)}`);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") scenarioError(`${path} must be a string`);
}

function validateEmitPayload(value: unknown, path: string): AdapterEventPayload {
  const emit = objectValue(value, path);
  if (typeof emit["type"] !== "string" || !Object.hasOwn(EVENT_KEYS, emit["type"])) {
    return scenarioError(`${path} has an unknown AdapterEvent type`);
  }
  const type = emit["type"] as AdapterEvent["type"];
  const fields = EVENT_KEYS[type];
  assertExactKeys(emit, path, fields.required, fields.optional);

  if (type === "model_request") {
    assertExactKeys(
      objectValue(emit["model"], `${path}.model`),
      `${path}.model`,
      ["provider", "model", "family"]
    );
  }
  if (type === "usage") {
    const usage = objectValue(emit["usage"], `${path}.usage`);
    assertExactKeys(
      usage,
      `${path}.usage`,
      [
        "requestId", "promptTokens", "completionTokens", "totalTokens",
        "costUsdMicros", "source"
      ]
    );
    if (usage["source"] !== "synthetic" || usage["costUsdMicros"] !== 0) {
      scenarioError(`${path}.usage must report synthetic source and zero cost`);
    }
  }

  const hasTruncated = "truncated" in emit;
  const hasOriginalSha256 = "originalSha256" in emit;
  if (hasTruncated !== hasOriginalSha256 || (hasTruncated && emit["truncated"] !== true)) {
    scenarioError(`${path} has incomplete truncation metadata`);
  }

  try {
    encodeAdapterEventFrame({
      ...emit,
      seq: 2,
      ts: EVENT_TIMESTAMP
    } as AdapterEvent);
  } catch (cause) {
    return scenarioError(`${path} is not an exact AdapterEvent payload`, cause);
  }
  return emit as AdapterEventPayload;
}

function validateStep(value: unknown, index: number): SimulatedStep {
  const path = `step ${index}`;
  const step = objectValue(value, path);
  if (Object.keys(step).length !== 1) scenarioError(`${path} must contain exactly one instruction`);

  if ("emit" in step) return { emit: validateEmitPayload(step["emit"], `${path}.emit`) };
  if ("sleep_ms" in step) {
    if (!Number.isSafeInteger(step["sleep_ms"]) || (step["sleep_ms"] as number) < 0) {
      scenarioError(`${path}.sleep_ms must be a non-negative safe integer`);
    }
    return { sleep_ms: step["sleep_ms"] as number };
  }
  if ("write_file" in step) {
    const directive = objectValue(step["write_file"], `${path}.write_file`);
    assertExactKeys(directive, `${path}.write_file`, ["path", "contents"]);
    assertString(directive["path"], `${path}.write_file.path`);
    assertString(directive["contents"], `${path}.write_file.contents`);
    return { write_file: { path: directive["path"], contents: directive["contents"] } };
  }
  if ("delete_file" in step) {
    const directive = objectValue(step["delete_file"], `${path}.delete_file`);
    assertExactKeys(directive, `${path}.delete_file`, ["path"]);
    assertString(directive["path"], `${path}.delete_file.path`);
    return { delete_file: { path: directive["path"] } };
  }
  if ("misbehave" in step) {
    if (typeof step["misbehave"] !== "string" ||
        !MISBEHAVIORS.has(step["misbehave"] as SimulatedMisbehavior)) {
      scenarioError(`${path}.misbehave is unknown`);
    }
    return { misbehave: step["misbehave"] as SimulatedMisbehavior };
  }
  return scenarioError(`${path} has an unknown instruction`);
}

export function parseSimulatedScenarioJson(input: string): SimulatedScenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (cause) {
    return scenarioError("input must be strict JSON", cause);
  }
  const scenario = objectValue(parsed, "scenario");
  assertExactKeys(scenario, "scenario", ["scenario_version", "steps"]);
  if (scenario["scenario_version"] !== 1) {
    return scenarioError("scenario_version must be the number 1");
  }
  if (!Array.isArray(scenario["steps"])) scenarioError("scenario.steps must be an array");
  return {
    scenario_version: 1,
    steps: scenario["steps"].map((step, index) => validateStep(step, index))
  };
}

function stdout(bytes: Uint8Array | string): SimulatedAction {
  return {
    kind: "stdout",
    bytes: typeof bytes === "string" ? encoder.encode(bytes) : bytes
  };
}

function payloadEvent(
  payload: AdapterEventPayload,
  seq: number,
  clock: SimulatedClock
): AdapterEvent {
  return { ...payload, seq, ts: clock.timestamp() } as AdapterEvent;
}

function encodedPayload(
  payload: AdapterEventPayload,
  seq: number,
  clock: SimulatedClock
): SimulatedAction {
  return stdout(encodeAdapterEventFrame(payloadEvent(payload, seq, clock)));
}

function modelRequest(requestId: string): AdapterEventPayload {
  return {
    type: "model_request",
    requestId,
    turn: 0,
    model: { provider: "synthetic", model: "scripted-v1", family: "synthetic" },
    messageCount: 1,
    inputSummarySha256: "0".repeat(64)
  };
}

function modelResponse(requestId: string): AdapterEventPayload {
  return {
    type: "model_response",
    requestId,
    status: "ok",
    stopReason: "tool_use",
    latencyMs: 0,
    text: "scripted"
  };
}

function syntheticUsage(requestId: string): AdapterEventPayload {
  return {
    type: "usage",
    usage: {
      requestId,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      costUsdMicros: 0,
      source: "synthetic"
    }
  };
}

function workspaceSegments(path: string): readonly string[] {
  if (path.length === 0 || isAbsolute(path) || win32.isAbsolute(path)) {
    return scenarioError("file directive path must remain inside the workspace");
  }
  const segments = path.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return scenarioError("file directive path must remain inside the workspace");
  }
  return segments;
}

async function rejectSymlinkComponents(workspace: string, segments: readonly string[]): Promise<void> {
  let current = workspace;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) {
        scenarioError("file directive path must remain inside the workspace (symlink rejected)");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
}

async function writeWorkspaceFile(
  workspace: string,
  directive: { readonly path: string; readonly contents: string }
): Promise<void> {
  const segments = workspaceSegments(directive.path);
  await rejectSymlinkComponents(workspace, segments);
  const target = join(workspace, ...segments);
  await mkdir(join(workspace, ...segments.slice(0, -1)), { recursive: true });
  await rejectSymlinkComponents(workspace, segments);
  await writeFile(target, directive.contents, "utf8");
}

async function deleteWorkspaceFile(
  workspace: string,
  directive: { readonly path: string }
): Promise<void> {
  const segments = workspaceSegments(directive.path);
  await rejectSymlinkComponents(workspace, segments);
  try {
    await unlink(join(workspace, ...segments));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

export async function* executeSimulatedScenario(
  scenario: SimulatedScenario,
  spec: AdapterRunSpec,
  options: ExecuteSimulatedScenarioOptions = {}
): AsyncIterable<SimulatedAction> {
  const clock = options.clock ?? new DeterministicClock();
  let nextSeq = 2;

  const emit = (payload: AdapterEventPayload): SimulatedAction => {
    const action = encodedPayload(payload, nextSeq, clock);
    nextSeq += 1;
    return action;
  };

  for (const step of scenario.steps) {
    if ("emit" in step) {
      yield emit(step.emit);
      continue;
    }
    if ("sleep_ms" in step) {
      await clock.sleep(step.sleep_ms);
      continue;
    }
    if ("write_file" in step) {
      await writeWorkspaceFile(spec.workspacePath, step.write_file);
      continue;
    }
    if ("delete_file" in step) {
      await deleteWorkspaceFile(spec.workspacePath, step.delete_file);
      continue;
    }

    switch (step.misbehave) {
      case "malformed_json":
        yield stdout("{\"type\":\n");
        break;
      case "garbage_stdout":
        yield stdout("garbage stdout\n");
        break;
      case "invalid_utf8":
        yield stdout(new Uint8Array([0xc3, 0x28, 0x0a]));
        break;
      case "oversized_frame":
        yield stdout(`${"x".repeat(MAX_ADAPTER_FRAME_BYTES)}\n`);
        break;
      case "sequence_gap": {
        const skippedSeq = nextSeq + 1;
        yield encodedPayload(
          { type: "log", level: "warn", message: "intentional sequence gap" },
          skippedSeq,
          clock
        );
        nextSeq = skippedSeq + 1;
        break;
      }
      case "post_terminal_frame":
        yield emit({ type: "log", level: "warn", message: "intentional post-terminal frame" });
        break;
      case "missing_tool_result": {
        const requestId = "missing-result-request";
        yield emit(modelRequest(requestId));
        yield emit(modelResponse(requestId));
        yield emit({
          type: "tool_call",
          callId: "missing-result-call",
          requestId,
          tool: "read_file",
          args: { path: "missing.txt" }
        });
        yield emit(syntheticUsage(requestId));
        break;
      }
      case "usage_arithmetic_error": {
        const requestId = "bad-usage-request";
        yield emit(modelRequest(requestId));
        yield emit(modelResponse(requestId));
        const malformedUsage = {
          type: "usage",
          seq: nextSeq,
          ts: clock.timestamp(),
          request_id: requestId,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 3,
          cost_usd_micros: 0,
          source: "synthetic"
        };
        yield stdout(`${JSON.stringify(malformedUsage)}\n`);
        break;
      }
      case "exit_zero_without_terminal":
        yield { kind: "exit", code: 0 };
        return;
      case "crash_at_step":
        yield { kind: "exit", code: 17 };
        return;
      case "early_exit":
        yield { kind: "exit", code: 3 };
        return;
      case "frame_flood":
        for (let index = 0; index < 50_001; index += 1) {
          yield emit({ type: "log", level: "debug", message: `frame ${index}` });
        }
        return;
      case "hang_until_timeout":
        yield { kind: "hang", ignoreSigterm: false };
        return;
      case "ignore_sigterm":
        yield { kind: "hang", ignoreSigterm: true };
        return;
    }
  }
}
