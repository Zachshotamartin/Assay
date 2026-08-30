#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { once } from "node:events";

import {
  AdapterLineSplitter,
  parseAdapterRunSpecFrame
} from "@assay/adapter-core";

import { SIMULATED_ADAPTER_HANDSHAKE_FRAME } from "./descriptor.js";
import {
  executeSimulatedScenario,
  parseSimulatedScenarioJson,
  type SimulatedAction
} from "./scenario.js";

function safeDiagnostic(message: string): void {
  process.stderr.write(`adapter-simulated: ${message}\n`);
}

function commandScenarioPath(argv: readonly string[]): string | null {
  const flags = argv.filter((argument) => argument === "--assay-adapter");
  const positional = argv.filter((argument) => argument !== "--assay-adapter");
  return flags.length === 1 && positional.length === 1 ? (positional[0] ?? null) : null;
}

async function writeStdout(bytes: Uint8Array | string): Promise<void> {
  if (process.stdout.write(bytes)) return;
  await once(process.stdout, "drain");
}

async function readRunSpecLine(): Promise<string> {
  const splitter = new AdapterLineSplitter();
  for await (const chunk of process.stdin) {
    const records = splitter.push(chunk);
    if (records.length === 0) continue;
    const record = records[0];
    if (
      record === undefined ||
      !record.ok ||
      records.length !== 1 ||
      splitter.bufferedByteLength !== 0
    ) {
      throw new Error("run specification framing is invalid");
    }
    process.stdin.pause();
    return record.text;
  }
  throw new Error("run specification was not received");
}

async function hang(action: Extract<SimulatedAction, { kind: "hang" }>): Promise<never> {
  if (action.ignoreSigterm) process.on("SIGTERM", () => undefined);
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

async function main(): Promise<number> {
  const scenarioPath = commandScenarioPath(process.argv.slice(2));
  if (scenarioPath === null) {
    safeDiagnostic("expected one scenario path and --assay-adapter");
    return 2;
  }

  let scenario: ReturnType<typeof parseSimulatedScenarioJson>;
  try {
    scenario = parseSimulatedScenarioJson(await readFile(scenarioPath, "utf8"));
  } catch {
    safeDiagnostic("scenario file is invalid");
    return 2;
  }

  await writeStdout(SIMULATED_ADAPTER_HANDSHAKE_FRAME);

  let spec: ReturnType<typeof parseAdapterRunSpecFrame>;
  try {
    spec = parseAdapterRunSpecFrame(await readRunSpecLine());
  } catch {
    safeDiagnostic("run specification is invalid");
    return 2;
  }

  try {
    for await (const action of executeSimulatedScenario(scenario, spec)) {
      switch (action.kind) {
        case "stdout":
          await writeStdout(action.bytes);
          break;
        case "exit":
          return action.code;
        case "hang":
          return await hang(action);
      }
    }
  } catch {
    safeDiagnostic("scenario execution failed");
    return 17;
  }
  return 0;
}

process.exitCode = await main();
