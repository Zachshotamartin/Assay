import { fileURLToPath } from "node:url";

export interface SimulatedAdapterCommandOptions {
  readonly scenarioPath?: string;
}

const packageRoot = new URL("../", import.meta.url);

export function resolveSimulatedScenarioPath(): string {
  return fileURLToPath(new URL("scenarios/happy-multi-turn.json", packageRoot));
}

export function simulatedAdapterCommand(
  options: SimulatedAdapterCommandOptions = {}
): readonly [string, ...string[]] {
  const scenarioPath = options.scenarioPath ?? resolveSimulatedScenarioPath();
  if (import.meta.url.endsWith(".ts")) {
    return [
      process.execPath,
      fileURLToPath(new URL("src/source-bootstrap.mjs", packageRoot)),
      scenarioPath
    ];
  }
  return [
    process.execPath,
    fileURLToPath(new URL("dist/bin.js", packageRoot)),
    scenarioPath
  ];
}
