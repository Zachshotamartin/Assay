import { parentPort, workerData } from "node:worker_threads";

interface WorkerInput {
  readonly bundleSource: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly trajectory: readonly unknown[];
  readonly maxLogBytes: number;
  readonly maxResultBytes: number;
}

interface WorkspaceResponse {
  readonly type: "workspace_response";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
}

interface CheckerModule {
  readonly check?: (context: unknown) => Promise<unknown> | unknown;
}

if (parentPort === null) {
  throw new Error("checker worker requires a parent port");
}
const port = parentPort;
const input = workerData as WorkerInput;
const bundleUrl = `data:text/javascript;base64,${Buffer.from(input.bundleSource, "utf8").toString("base64")}`;
const pending = new Map<number, {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}>();
let requestId = 0;
let loggedBytes = 0;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function workspaceRequest(operation: string, path?: string): Promise<unknown> {
  const id = requestId;
  requestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage(path === undefined
      ? { type: "workspace_request", id, operation }
      : { type: "workspace_request", id, operation, path });
  });
}

port.on("message", (message: WorkspaceResponse) => {
  if (message.type !== "workspace_response" || !Number.isInteger(message.id)) {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter === undefined) {
    return;
  }
  pending.delete(message.id);
  if (message.ok) {
    waiter.resolve(message.value);
  } else {
    waiter.reject(new Error(message.message ?? "workspace request failed"));
  }
});

const task = deepFreeze(structuredClone(input.task));
const trajectoryEvents = deepFreeze(structuredClone(input.trajectory));
const context = deepFreeze({
  task,
  workspace: {
    exists: async (path: string) => Boolean(await workspaceRequest("exists", path)),
    readText: async (path: string) => String(await workspaceRequest("readText", path)),
    readBytes: async (path: string) => {
      const value = await workspaceRequest("readBytes", path);
      if (!(value instanceof Uint8Array)) {
        throw new Error("workspace byte response is malformed");
      }
      return value;
    },
    list: async (path?: string) => {
      const value = await workspaceRequest("list", path);
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error("workspace list response is malformed");
      }
      return Object.freeze([...value]);
    }
  },
  trajectory: {
    events: () => trajectoryEvents
  },
  log: (message: string) => {
    if (typeof message !== "string") {
      throw new TypeError("checker log message must be a string");
    }
    const bounded = message.slice(0, 4_096);
    const bytes = new TextEncoder().encode(bounded).byteLength;
    if (loggedBytes + bytes <= input.maxLogBytes) {
      loggedBytes += bytes;
      port.postMessage({ type: "log", message: bounded });
    }
  }
});

function removeAmbientCapability(name: string): void {
  try {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false
    });
  } catch {
    // A non-configurable platform global is overwritten where possible below.
    try {
      (globalThis as Record<string, unknown>)[name] = undefined;
    } catch {
      // Static import validation and the outer sandbox remain the backstop.
    }
  }
}

function blockedStringCodeGeneration(): never {
  throw new EvalError("checker string code generation is disabled");
}

function disableStringCodeGeneration(): void {
  const constructors = [
    (() => undefined).constructor,
    (async () => undefined).constructor,
    (function* (): Generator<never, void, unknown> { return undefined; }).constructor,
    (async function* (): AsyncGenerator<never, void, unknown> { return undefined; }).constructor
  ];
  for (const constructor of constructors) {
    const prototype = (constructor as { readonly prototype?: object }).prototype;
    if (prototype !== undefined) {
      Object.defineProperty(prototype, "constructor", {
        value: blockedStringCodeGeneration,
        writable: false,
        enumerable: false,
        configurable: false
      });
    }
  }
  for (const name of ["eval", "Function"] as const) {
    Object.defineProperty(globalThis, name, {
      value: blockedStringCodeGeneration,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
}

disableStringCodeGeneration();
for (const name of ["fetch", "WebSocket", "EventSource", "process"] as const) {
  removeAmbientCapability(name);
}
const silent = (): void => undefined;
Object.defineProperty(globalThis, "console", {
  value: Object.freeze({
    log: silent,
    info: silent,
    warn: silent,
    error: silent,
    debug: silent,
    trace: silent
  }),
  writable: false,
  configurable: false
});

try {
  const checkerModule = await import(bundleUrl) as CheckerModule;
  if (typeof checkerModule.check !== "function") {
    throw new Error("checker bundle has no callable check export");
  }
  const verdict = await checkerModule.check(context);
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(verdict, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("checker verdict contains a non-finite number");
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" ||
        typeof value === "undefined") {
      throw new TypeError(`checker verdict contains unsupported ${typeof value}`);
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        throw new TypeError("checker verdict contains a cycle or repeated object reference");
      }
      seen.add(value);
    }
    return value;
  });
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > input.maxResultBytes) {
    throw new Error(`checker verdict exceeds ${input.maxResultBytes} bytes`);
  }
  port.postMessage({ type: "result", verdict: JSON.parse(serialized) as unknown });
} catch (error) {
  const message = error instanceof Error ? error.message : "checker threw a non-Error value";
  port.postMessage({ type: "error", message: message.slice(0, 4_096) });
} finally {
  port.close();
}
