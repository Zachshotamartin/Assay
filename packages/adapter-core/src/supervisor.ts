import { spawn as spawnChild } from "node:child_process";

import { AssayError, type AssayErrorCategory } from "@assay/contracts";

import {
  encodeAdapterEventFrame,
  parseAdapterEventFrameDetailed,
  parseAdapterHandshakeFrame,
  serializeAdapterRunSpec,
  type DefensiveTruncation
} from "./frames/codec.js";
import {
  AdapterLineSplitter,
  AdapterStreamBudget,
  BoundedHeadTailBuffer,
  MAX_ADAPTER_STDERR_BYTES,
  type AdapterLineRecord
} from "./frames/line-splitter.js";
import { AdapterEventOrderValidator } from "./frames/order-validator.js";
import {
  MalformedFramePolicy,
  type AdapterCaptureRedactor,
  type MalformedFrameClassification,
  type MalformedFrameDiagnostic
} from "./malformed-policy.js";
import type { AdapterDescriptor, AdapterEvent, AdapterRunSpec } from "./types.js";

export const HANDSHAKE_DEADLINE_MS = 10_000;
export const TERMINAL_EXIT_DEADLINE_MS = 5_000;
export const TERMINATION_GRACE_MS = 5_000;

export interface ScheduledCallback {
  cancel(): void;
}

export interface AdapterScheduler {
  schedule(delayMs: number, callback: () => void): ScheduledCallback;
}

export interface AdapterProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: boolean;
}

export interface AdapterChildProcess {
  readonly stdin: { write(value: string): void | Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exit: Promise<AdapterProcessExit>;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export interface SpawnAdapterOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type SpawnAdapterProcess = (
  argv: readonly string[],
  options: SpawnAdapterOptions
) => AdapterChildProcess;

export interface SuperviseAdapterOptions {
  readonly command: readonly [string, ...string[]];
  readonly spec: AdapterRunSpec;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly redactor: AdapterCaptureRedactor;
  readonly signal?: AbortSignal;
  readonly scheduler?: AdapterScheduler;
  readonly spawn?: SpawnAdapterProcess;
}

export interface AdapterStderrCapture {
  readonly redacted: string;
  readonly droppedBytes: number;
}

export interface AdapterSupervisionResult {
  readonly status: "completed" | "failed" | "error";
  readonly errorCategory: AssayErrorCategory | null;
  readonly descriptor: AdapterDescriptor | null;
  readonly events: readonly AdapterEvent[];
  readonly diagnostics: readonly MalformedFrameDiagnostic[];
  readonly malformedFrameCount: number;
  readonly defensiveTruncations: readonly DefensiveTruncation[];
  readonly incomplete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly stderr: AdapterStderrCapture;
  readonly exit: AdapterProcessExit;
  readonly termination: {
    readonly sigtermSent: boolean;
    readonly sigkillSent: boolean;
    readonly truncationMarker: string | null;
  };
}

const realScheduler: AdapterScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }
};

function defaultSpawn(argv: readonly string[], options: SpawnAdapterOptions): AdapterChildProcess {
  const [file, ...args] = argv;
  if (file === undefined) {
    throw new AssayError("adapter_unavailable", "adapter_unavailable: adapter command is empty");
  }
  const child = spawnChild(file, args, {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let spawnError = false;
  const exit = new Promise<AdapterProcessExit>((resolve) => {
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (code, signal) => resolve({ code, signal, ...(spawnError ? { spawnError: true } : {}) }));
  });
  return {
    stdin: {
      write(value) {
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(value, (error) =>
            error === null || error === undefined ? resolve() : reject(error)
          );
        });
      }
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exit,
    kill: (signal) => child.kill(signal)
  };
}

function errorResult(category: AssayErrorCategory): AdapterSupervisionResult {
  return {
    status: "error",
    errorCategory: category,
    descriptor: null,
    events: [],
    diagnostics: [],
    malformedFrameCount: 0,
    defensiveTruncations: [],
    incomplete: true,
    incompleteReasons: [category],
    stderr: { redacted: "", droppedBytes: 0 },
    exit: { code: null, signal: null, ...(category === "adapter_unavailable" ? { spawnError: true } : {}) },
    termination: { sigtermSent: false, sigkillSent: false, truncationMarker: null }
  };
}

function classifyCodecError(error: unknown): MalformedFrameClassification {
  if (error instanceof Error && error.message.includes("not valid JSON")) return "invalid_json";
  return "schema_validation";
}

function jsonAfterRedaction(value: unknown, redactor: AdapterCaptureRedactor): string {
  try {
    const redacted = redactor.redactJson(value);
    const serialized = JSON.stringify(redacted);
    if (serialized === undefined) throw new Error("redactor returned an unserializable value");
    return serialized;
  } catch (cause) {
    throw new AssayError(
      "redaction_failed",
      "redaction_failed: adapter frame could not be redacted",
      { cause }
    );
  }
}

function redactValidHandshake(
  text: string,
  redactor: AdapterCaptureRedactor
): ReturnType<typeof parseAdapterHandshakeFrame> {
  parseAdapterHandshakeFrame(text);
  const value = JSON.parse(text) as unknown;
  try {
    return parseAdapterHandshakeFrame(jsonAfterRedaction(value, redactor));
  } catch (cause) {
    if (cause instanceof AssayError && cause.category === "redaction_failed") throw cause;
    throw new AssayError(
      "redaction_failed",
      "redaction_failed: redaction invalidated the adapter handshake",
      { cause }
    );
  }
}

function redactValidEvent(
  text: string,
  redactor: AdapterCaptureRedactor
): ReturnType<typeof parseAdapterEventFrameDetailed> {
  const original = parseAdapterEventFrameDetailed(text);
  const normalizedWire = JSON.parse(encodeAdapterEventFrame(original.event).slice(0, -1)) as unknown;
  let redacted: ReturnType<typeof parseAdapterEventFrameDetailed>;
  try {
    redacted = parseAdapterEventFrameDetailed(jsonAfterRedaction(normalizedWire, redactor));
  } catch (cause) {
    if (cause instanceof AssayError && cause.category === "redaction_failed") throw cause;
    throw new AssayError(
      "redaction_failed",
      "redaction_failed: redaction invalidated an adapter event",
      { cause }
    );
  }
  return {
    event: redacted.event,
    defensiveTruncations: [
      ...original.defensiveTruncations,
      ...redacted.defensiveTruncations
    ]
  };
}

export async function superviseAdapter(
  options: SuperviseAdapterOptions
): Promise<AdapterSupervisionResult> {
  const scheduler = options.scheduler ?? realScheduler;
  const spawn = options.spawn ?? defaultSpawn;
  let child: AdapterChildProcess;
  try {
    child = spawn([...options.command, "--assay-adapter"], {
      cwd: options.cwd,
      env: { ...options.env }
    });
  } catch {
    return errorResult("adapter_unavailable");
  }

  let fatalCategory: AssayErrorCategory | null = null;
  let fatalReason: string | null = null;
  let sigtermSent = false;
  let sigkillSent = false;
  let descriptor: AdapterDescriptor | null = null;
  let order: AdapterEventOrderValidator | null = null;
  let expectedSeq = 1;
  let runSpecWritten = false;
  let postTerminalOutput = false;
  let incomplete = false;
  const incompleteReasons: string[] = [];
  const events: AdapterEvent[] = [];
  const defensiveTruncations: DefensiveTruncation[] = [];
  const malformed = new MalformedFramePolicy(options.redactor);
  const splitter = new AdapterLineSplitter();
  const streamBudget = new AdapterStreamBudget();
  const stderrBuffer = new BoundedHeadTailBuffer();
  let handshakeTimer: ScheduledCallback | null = null;
  let terminalTimer: ScheduledCallback | null = null;
  let wallTimer: ScheduledCallback | null = null;
  let graceTimer: ScheduledCallback | null = null;
  const currentOrder = (): AdapterEventOrderValidator | null => order;
  const cancelScheduled = (scheduled: ScheduledCallback | null): void => scheduled?.cancel();

  const initiateFailure = (category: AssayErrorCategory, reason: string): void => {
    if (fatalCategory !== null) return;
    fatalCategory = category;
    fatalReason = reason;
    incomplete = true;
    incompleteReasons.push(reason);
    if (!sigtermSent) {
      sigtermSent = true;
      try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
      graceTimer = scheduler.schedule(TERMINATION_GRACE_MS, () => {
        if (sigkillSent) return;
        sigkillSent = true;
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      });
    }
  };

  const recordMalformed = (
    classification: MalformedFrameClassification,
    sample: Uint8Array,
    byteLength = sample.byteLength
  ): void => {
    incomplete = true;
    try {
      malformed.record(classification, sample, byteLength);
    } catch (error) {
      initiateFailure(
        error instanceof AssayError ? error.category : "redaction_failed",
        "adapter malformed-frame redaction failed"
      );
      return;
    }
    if (malformed.exceeded) {
      initiateFailure("adapter_protocol_error", "adapter exceeded 10 malformed frames");
    }
  };

  const handleLine = async (record: AdapterLineRecord): Promise<void> => {
    if (fatalCategory !== null) return;
    const existingOrder = currentOrder();
    if (existingOrder !== null && existingOrder.finish().terminal !== null) {
      postTerminalOutput = true;
      recordMalformed(
        "post_terminal",
        record.ok ? new TextEncoder().encode(record.text) : record.sample,
        record.byteLength
      );
      return;
    }
    if (!record.ok) {
      recordMalformed(record.classification, record.sample, record.byteLength);
      if (descriptor === null && fatalCategory === null) {
        initiateFailure("adapter_protocol_error", "adapter handshake was malformed");
      }
      return;
    }

    if (descriptor === null) {
      try {
        const handshake = redactValidHandshake(record.text, options.redactor);
        descriptor = handshake.descriptor;
        order = new AdapterEventOrderValidator(descriptor.tier);
        expectedSeq = 2;
        handshakeTimer?.cancel();
        handshakeTimer = null;
      } catch (error) {
        if (error instanceof AssayError && error.category === "redaction_failed") {
          initiateFailure("redaction_failed", "adapter handshake redaction failed");
          return;
        }
        const bytes = new TextEncoder().encode(record.text);
        recordMalformed(classifyCodecError(error), bytes, record.byteLength);
        if (fatalCategory === null) {
          initiateFailure(
            error instanceof AssayError && error.category === "adapter_nonconformant"
              ? "adapter_nonconformant"
              : "adapter_protocol_error",
            "adapter handshake was rejected"
          );
        }
        return;
      }
      try {
        await child.stdin.write(serializeAdapterRunSpec(options.spec));
        runSpecWritten = true;
      } catch {
        initiateFailure("adapter_protocol_error", "adapter run specification could not be written");
      }
      return;
    }

    let parsed: ReturnType<typeof parseAdapterEventFrameDetailed>;
    try {
      parsed = redactValidEvent(record.text, options.redactor);
    } catch (error) {
      if (error instanceof AssayError && error.category === "redaction_failed") {
        initiateFailure("redaction_failed", "adapter event redaction failed");
        return;
      }
      recordMalformed(classifyCodecError(error), new TextEncoder().encode(record.text), record.byteLength);
      return;
    }
    const event = parsed.event;
    if (event.seq !== expectedSeq) {
      recordMalformed("sequence", new TextEncoder().encode(record.text), record.byteLength);
      expectedSeq = event.seq + 1;
      return;
    }
    expectedSeq += 1;
    const eventOrder = currentOrder();
    if (eventOrder === null) {
      initiateFailure("adapter_protocol_error", "adapter event arrived before handshake state");
      return;
    }
    const orderingError = eventOrder.accept(event);
    if (orderingError !== null) {
      recordMalformed("cross_frame", new TextEncoder().encode(record.text), record.byteLength);
      return;
    }
    defensiveTruncations.push(...parsed.defensiveTruncations);
    if (parsed.defensiveTruncations.length > 0) incomplete = true;
    events.push(event);
    if (event.type === "run_completed" || event.type === "run_failed") {
      terminalTimer = scheduler.schedule(TERMINAL_EXIT_DEADLINE_MS, () => {
        initiateFailure("adapter_protocol_error", "adapter did not exit within 5 seconds of terminal frame");
      });
    }
  };

  handshakeTimer = scheduler.schedule(HANDSHAKE_DEADLINE_MS, () => {
    initiateFailure("adapter_protocol_error", "adapter handshake deadline exceeded");
  });
  wallTimer = scheduler.schedule(options.spec.limits.wallClockMs, () => {
    initiateFailure("sandbox_timeout", "adapter wall-clock limit exceeded");
  });

  const abort = (): void => initiateFailure("cancelled", "adapter run cancelled");
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const stdoutDone = (async (): Promise<void> => {
    try {
      for await (const chunk of child.stdout) {
        if (!streamBudget.recordBytes(chunk.byteLength)) {
          initiateFailure("adapter_protocol_error", "adapter exceeded the 256 MiB stdout budget");
          return;
        }
        for (const record of splitter.push(chunk)) {
          if (!streamBudget.recordFrames()) {
            initiateFailure("adapter_protocol_error", "adapter exceeded the 50,000-frame budget");
            return;
          }
          await handleLine(record);
        }
      }
      for (const record of splitter.finish()) {
        if (!streamBudget.recordFrames()) {
          initiateFailure("adapter_protocol_error", "adapter exceeded the 50,000-frame budget");
          return;
        }
        await handleLine(record);
      }
    } catch {
      initiateFailure("adapter_protocol_error", "adapter stdout collection failed");
    }
  })();

  const stderrDone = (async (): Promise<void> => {
    try {
      for await (const chunk of child.stderr) stderrBuffer.push(chunk);
    } catch {
      initiateFailure("adapter_protocol_error", "adapter stderr collection failed");
    }
  })();

  let exit: AdapterProcessExit;
  try {
    exit = await child.exit;
  } catch {
    exit = { code: null, signal: null, spawnError: true };
  }
  handshakeTimer?.cancel();
  wallTimer?.cancel();
  cancelScheduled(terminalTimer);
  cancelScheduled(graceTimer);
  options.signal?.removeEventListener("abort", abort);
  await Promise.allSettled([stdoutDone, stderrDone]);

  const finalOrder = currentOrder()?.finish() ?? {
    terminal: null,
    postTerminal: false,
    incompleteReasons: ["missing handshake"]
  };
  if (finalOrder.incompleteReasons.length > 0) {
    incomplete = true;
    incompleteReasons.push(...finalOrder.incompleteReasons);
  }

  let stderr: AdapterStderrCapture = { redacted: "", droppedBytes: 0 };
  const stderrSnapshot = stderrBuffer.snapshot();
  try {
    stderr = {
      redacted: options.redactor.redactBytes(stderrSnapshot.bytes),
      droppedBytes: stderrSnapshot.droppedBytes
    };
  } catch {
    if (fatalCategory === null) {
      fatalCategory = "redaction_failed";
      fatalReason = "adapter stderr redaction failed";
      incomplete = true;
      incompleteReasons.push(fatalReason);
    }
  }

  if (fatalCategory === null && exit.spawnError === true) {
    fatalCategory = "adapter_unavailable";
    fatalReason = "adapter process could not be spawned";
  }
  if (fatalCategory === null && (exit.code !== 0 || exit.signal !== null)) {
    fatalCategory = "adapter_protocol_error";
    fatalReason = "adapter exited nonzero or by signal";
  }
  if (fatalCategory === null && (!runSpecWritten || descriptor === null)) {
    fatalCategory = "adapter_protocol_error";
    fatalReason = "adapter exited without a valid handshake";
  }
  if (fatalCategory === null && finalOrder.terminal === null) {
    fatalCategory = "adapter_protocol_error";
    fatalReason = "adapter exited without a terminal frame";
  }
  if (fatalCategory === null && (finalOrder.postTerminal || postTerminalOutput)) {
    fatalCategory = "adapter_protocol_error";
    fatalReason = "adapter emitted output after its terminal frame";
  }

  if (fatalCategory !== null && !incompleteReasons.includes(fatalReason ?? "")) {
    incomplete = true;
    if (fatalReason !== null) incompleteReasons.push(fatalReason);
  }
  const status = fatalCategory !== null
    ? "error"
    : finalOrder.terminal?.type === "run_failed"
      ? "failed"
      : "completed";

  return {
    status,
    errorCategory: fatalCategory,
    descriptor,
    events,
    diagnostics: malformed.diagnostics,
    malformedFrameCount: malformed.count,
    defensiveTruncations,
    incomplete,
    incompleteReasons,
    stderr,
    exit,
    termination: {
      sigtermSent,
      sigkillSent,
      truncationMarker: fatalReason
    }
  };
}

export type { AdapterCaptureRedactor } from "./malformed-policy.js";
