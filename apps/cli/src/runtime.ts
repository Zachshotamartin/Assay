import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  createRunId,
  createTaskRunId,
  type Clock,
  type IdSource,
  type RunId,
  type TaskRunId
} from "@assay/contracts";

export type AdapterCommand = readonly [string, ...string[]];

export interface CliRuntime {
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly runIdSource: IdSource<RunId>;
  readonly taskRunIdSource: IdSource<TaskRunId>;
  readonly eventIdSource: IdSource<string>;
  readonly processId: number;
  readonly signal: AbortSignal;
  readonly adapterCommandFor: (adapterId: string) => AdapterCommand;
}

interface ProcessRuntime {
  readonly runtime: CliRuntime;
  readonly dispose: () => void;
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identifierSource<T extends string>(validate: (value: string) => T): IdSource<T> {
  return { next: () => validate(uuidV7()) };
}

function environmentSnapshot(): Readonly<Record<string, string | undefined>> {
  const entries = Object.entries(process.env).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze(Object.fromEntries(entries));
}

export function createProcessRuntime(
  projectRoot: string,
  adapterCommandFor: CliRuntime["adapterCommandFor"]
): ProcessRuntime {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const runtime: CliRuntime = {
    projectRoot,
    environment: environmentSnapshot(),
    clock: {
      wallTime: () => new Date().toISOString(),
      // Durable canonical records only admit integers; millisecond precision is
      // the public clock contract, so discard the platform's fractional ticks.
      monotonicMilliseconds: () => Math.floor(performance.now())
    },
    runIdSource: identifierSource(createRunId),
    taskRunIdSource: identifierSource(createTaskRunId),
    eventIdSource: { next: uuidV7 },
    processId: process.pid,
    signal: controller.signal,
    adapterCommandFor
  };
  return {
    runtime,
    dispose: () => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  };
}
