import { Worker } from "node:worker_threads";

import { build } from "esbuild";

import { validateCheckerModule } from "./checker-validation.js";
import type {
  CheckerAssertionResult,
  CheckerAssertionSpec,
  CheckerExecutionContext,
  CheckerVerdict
} from "./types.js";
import { validateWorkspacePath } from "./validation.js";
import {
  inspectWorkspacePath,
  readWorkspaceFile,
  readWorkspaceTree
} from "./workspace.js";

const CHECKER_WORKSPACE_READ_LIMIT_BYTES = 10_485_760;
const CHECKER_LOG_LIMIT_BYTES = 65_536;
const CHECKER_STREAM_LIMIT_BYTES = 65_536;
const CHECKER_RESULT_LIMIT_BYTES = 1_048_576;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface WorkerRequest {
  readonly type: "workspace_request";
  readonly id: number;
  readonly operation: string;
  readonly path?: string;
}

interface WorkerResultMessage {
  readonly type: "result";
  readonly verdict: unknown;
}

interface WorkerErrorMessage {
  readonly type: "error";
  readonly message: string;
}

interface WorkerLogMessage {
  readonly type: "log";
  readonly message: string;
}

type WorkerMessage = WorkerRequest | WorkerResultMessage | WorkerErrorMessage | WorkerLogMessage;

function abortError(): DOMException {
  return new DOMException("Checker evaluation was cancelled", "AbortError");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "checker worker failed";
  if (/memory limit|heap out of memory|ERR_WORKER_OUT_OF_MEMORY/iu.test(message)) {
    return `checker exceeded its worker memory resource limit: ${message}`;
  }
  return message;
}

function isDetails(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkerVerdict(value: unknown): CheckerVerdict | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.some((key) => !new Set(["verdict", "observed", "expectation", "details"]).has(key))) {
    return undefined;
  }
  if (
    (record["verdict"] !== "pass" && record["verdict"] !== "fail") ||
    typeof record["observed"] !== "string" ||
    typeof record["expectation"] !== "string" ||
    (record["details"] !== undefined && !isDetails(record["details"]))
  ) {
    return undefined;
  }
  try {
    structuredClone(record);
  } catch {
    return undefined;
  }
  return record as unknown as CheckerVerdict;
}

async function bundleChecker(modulePath: string): Promise<string> {
  const output = await build({
    entryPoints: [modulePath],
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    target: "es2023",
    logLevel: "silent",
    legalComments: "none",
    treeShaking: true
  });
  const file = output.outputFiles[0];
  if (file === undefined) {
    throw new Error("checker bundler produced no output");
  }
  return file.text;
}

function workerEntryUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./checker-worker-entry${extension}`, import.meta.url);
}

async function workspaceResponse(
  request: WorkerRequest,
  workspaceRoot: string
): Promise<unknown> {
  if (!Number.isInteger(request.id) || request.id < 0) {
    throw new Error("checker workspace request id is invalid");
  }
  if (request.operation === "list" && request.path === undefined) {
    return [...(await readWorkspaceTree(workspaceRoot)).keys()].sort();
  }
  const path = validateWorkspacePath(request.path, "checker workspace path");
  switch (request.operation) {
    case "exists": {
      const inspected = await inspectWorkspacePath(workspaceRoot, path);
      if (inspected.status === "blocked_symlink") {
        throw new Error("checker workspace path traverses a symlink");
      }
      return inspected.status === "present";
    }
    case "readText": {
      const bytes = await readWorkspaceFile(workspaceRoot, path, CHECKER_WORKSPACE_READ_LIMIT_BYTES);
      const text = UTF8.decode(bytes);
      return text.startsWith("\ufeff") ? text.slice(1) : text;
    }
    case "readBytes":
      return readWorkspaceFile(workspaceRoot, path, CHECKER_WORKSPACE_READ_LIMIT_BYTES);
    case "list": {
      const tree = await readWorkspaceTree(workspaceRoot);
      const prefix = path === "." ? "" : `${path.replace(/\/$/u, "")}/`;
      return [...tree.keys()].filter((entry) => entry.startsWith(prefix)).sort();
    }
    default:
      throw new Error(`unknown checker workspace operation ${request.operation}`);
  }
}

function targetFor(spec: CheckerAssertionSpec): string {
  return spec.name ?? spec.module;
}

function errorResult(
  spec: CheckerAssertionSpec,
  message: string,
  durationMs: number,
  logs: readonly string[]
): CheckerAssertionResult {
  return {
    type: "checker",
    target: targetFor(spec),
    observed: { error: message },
    expectation: "valid CheckerVerdict",
    verdict: "error",
    durationMs,
    errorCategory: "assertion_error",
    message,
    logs
  };
}

function elapsed(context: CheckerExecutionContext, start: number): number {
  const duration = context.clock.monotonicMilliseconds() - start;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("checker assertion clock moved backwards or returned a non-finite duration");
  }
  return duration;
}

async function runWorker(
  spec: CheckerAssertionSpec,
  context: CheckerExecutionContext,
  bundleSource: string,
  signal: AbortSignal,
  start: number
): Promise<CheckerAssertionResult> {
  if (signal.aborted) {
    throw abortError();
  }
  const logs: string[] = [];
  let streamBytes = 0;
  let settled = false;

  return new Promise<CheckerAssertionResult>((resolveResult, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerEntryUrl(), {
        workerData: {
          bundleSource,
          task: context.task,
          trajectory: context.trajectory,
          maxLogBytes: CHECKER_LOG_LIMIT_BYTES,
          maxResultBytes: CHECKER_RESULT_LIMIT_BYTES
        },
        env: {},
        argv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: spec.memory_mb ?? 256,
          maxYoungGenerationSizeMb: Math.min(16, Math.max(4, Math.floor((spec.memory_mb ?? 256) / 8))),
          codeRangeSizeMb: 16,
          stackSizeMb: 4
        }
      });
    } catch (error) {
      resolveResult(errorResult(spec, errorMessage(error), elapsed(context, start), logs));
      return;
    }

    const deadline = context.deadlineScheduler.schedule(spec.timeout_ms ?? 10_000, () => {
      void finish(errorResult(
        spec,
        `checker timed out after ${spec.timeout_ms ?? 10_000} ms`,
        elapsed(context, start),
        logs
      ));
    });
    const clean = (): void => {
      deadline.cancel();
      signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
      worker.stdout?.removeAllListeners();
      worker.stderr?.removeAllListeners();
    };
    const finish = async (result: CheckerAssertionResult): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      clean();
      await worker.terminate().catch(() => undefined);
      resolveResult(result);
    };
    const fail = async (error: unknown): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      clean();
      await worker.terminate().catch(() => undefined);
      reject(error);
    };
    const onAbort = (): void => {
      void fail(abortError());
    };
    const captureWorkerStream = (chunk: Buffer): void => {
      streamBytes += chunk.byteLength;
      if (streamBytes > CHECKER_STREAM_LIMIT_BYTES) {
        void finish(errorResult(
          spec,
          `checker wrote more than ${CHECKER_STREAM_LIMIT_BYTES} bytes outside the bounded logger`,
          elapsed(context, start),
          logs
        ));
      }
    };

    worker.stdout?.on("data", captureWorkerStream);
    worker.stderr?.on("data", captureWorkerStream);
    worker.on("message", (message: WorkerMessage) => {
      if (settled || typeof message !== "object" || message === null) {
        return;
      }
      if (message.type === "workspace_request") {
        void workspaceResponse(message, context.workspaceRoot).then(
          (value) => worker.postMessage({ type: "workspace_response", id: message.id, ok: true, value }),
          (error: unknown) => worker.postMessage({
            type: "workspace_response",
            id: message.id,
            ok: false,
            message: error instanceof Error ? error.message : "workspace request failed"
          })
        );
        return;
      }
      if (message.type === "log") {
        if (typeof message.message !== "string") {
          void finish(errorResult(spec, "checker emitted a malformed log", elapsed(context, start), logs));
        } else {
          logs.push(message.message);
        }
        return;
      }
      if (message.type === "error") {
        void finish(errorResult(
          spec,
          typeof message.message === "string" ? message.message : "checker threw",
          elapsed(context, start),
          logs
        ));
        return;
      }
      if (message.type === "result") {
        const verdict = checkerVerdict(message.verdict);
        if (verdict === undefined) {
          void finish(errorResult(
            spec,
            "checker returned a malformed CheckerVerdict",
            elapsed(context, start),
            logs
          ));
          return;
        }
        const base = {
          type: "checker" as const,
          target: targetFor(spec),
          observed: verdict.observed,
          expectation: verdict.expectation,
          verdict: verdict.verdict,
          durationMs: elapsed(context, start),
          logs: Object.freeze([...logs])
        };
        void finish(verdict.details === undefined
          ? base
          : { ...base, details: verdict.details });
      }
    });
    worker.once("error", (error) => {
      void finish(errorResult(spec, errorMessage(error), elapsed(context, start), logs));
    });
    worker.once("exit", (code) => {
      if (!settled) {
        void finish(errorResult(
          spec,
          code === 0
            ? "checker worker exited without a verdict"
            : `checker worker exited with code ${code} (resource limit or crash)`,
          elapsed(context, start),
          logs
        ));
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function evaluateCheckerAssertion(
  spec: CheckerAssertionSpec,
  context: CheckerExecutionContext,
  signal: AbortSignal
): Promise<CheckerAssertionResult> {
  const validated = await validateCheckerModule(spec, context.projectRoot);
  const bundleSource = await bundleChecker(validated.modulePath).catch((error: unknown) => {
    throw new Error(`checker bundle failed after validation: ${errorMessage(error)}`);
  });
  if (signal.aborted) {
    throw abortError();
  }
  const start = context.clock.monotonicMilliseconds();
  return runWorker(spec, context, bundleSource, signal, start);
}
