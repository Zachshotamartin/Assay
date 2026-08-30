import type { TaskId, TaskRunId } from "@assay/contracts";

export const ADAPTER_CONTRACT_VERSION = "assay-adapter/1" as const;

export type AdapterTier = "full" | "trajectory" | "black_box";
export type ToolSemanticClass = "read" | "write" | "execute";

export interface ToolCatalogEntry {
  readonly name: string;
  readonly semanticClass: ToolSemanticClass;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly family: string;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  readonly tier: AdapterTier;
  readonly model: ModelIdentity | null;
  readonly toolCatalog: readonly ToolCatalogEntry[];
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface AdapterRunSpec {
  readonly taskId: TaskId;
  readonly taskRunId: TaskRunId;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly seed: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: { readonly wallClockMs: number };
  readonly budgetsAdvisory: {
    readonly totalTokens?: number;
    readonly toolCalls?: number;
    readonly usdMicros?: number;
  };
}

export interface AgentAdapter {
  readonly descriptor: AdapterDescriptor;
  start(spec: AdapterRunSpec, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}

interface AdapterEventBase<T extends string> {
  readonly type: T;
  readonly seq: number;
  readonly ts: string;
}

export interface UsageReport {
  readonly requestId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsdMicros: number | null;
  readonly source: "provider" | "synthetic";
}

export type AdapterEvent =
  | (AdapterEventBase<"session_started"> & { readonly sessionId: string })
  | (AdapterEventBase<"model_request"> & {
      readonly requestId: string;
      readonly turn: number;
      readonly model: ModelIdentity;
      readonly messageCount: number;
      readonly inputSummarySha256: string;
    })
  | (AdapterEventBase<"model_response"> & {
      readonly requestId: string;
      readonly status: "ok" | "provider_error" | "timeout";
      readonly stopReason:
        | "end_turn"
        | "tool_use"
        | "max_tokens"
        | "refusal"
        | "other"
        | null;
      readonly latencyMs: number;
      readonly text: string | null;
    })
  | (AdapterEventBase<"tool_call"> & {
      readonly callId: string;
      readonly requestId: string;
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    })
  | (AdapterEventBase<"tool_result"> & {
      readonly callId: string;
      readonly status: "ok" | "error" | "timeout";
      readonly result: string;
      readonly durationMs: number;
    })
  | (AdapterEventBase<"usage"> & { readonly usage: UsageReport })
  | (AdapterEventBase<"text_output"> & { readonly text: string })
  | (AdapterEventBase<"run_completed"> & { readonly summary: string })
  | (AdapterEventBase<"run_failed"> & {
      readonly category: "agent_gave_up" | "agent_crashed" | "provider_error" | "internal";
      readonly message: string;
    })
  | (AdapterEventBase<"log"> & {
      readonly level: "debug" | "info" | "warn" | "error";
      readonly message: string;
    });

export interface AdapterHandshake {
  readonly type: "handshake";
  readonly seq: 1;
  readonly descriptor: AdapterDescriptor;
}
