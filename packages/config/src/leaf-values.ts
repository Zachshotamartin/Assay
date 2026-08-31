import { MAX_CONFIG_STRING_LENGTH } from "./constants.js";
import { configError } from "./errors.js";
import type { MutableAssayConfig } from "./internal-types.js";
import type {
  AssayConfig,
  AssayConfigLeafPath
} from "./types.js";

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CONFIG_STRING_LENGTH;
}

export function isValidLeafValue(path: AssayConfigLeafPath, value: unknown): boolean {
  switch (path) {
    case "configVersion":
      return value === 1;
    case "concurrency":
      return isSafeIntegerInRange(value, 1, 64);
    case "runsPerTask":
      return isSafeIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER);
    case "defaultAdapter":
    case "storePath":
    case "redaction.rulesetVersion":
    case "pricingCatalogVersion":
      return isBoundedString(value);
    case "sandbox.socketPath":
    case "comparison.baseline":
      return value === null || isBoundedString(value);
    case "sandbox.defaultCpus":
    case "sandbox.defaultMemoryMib":
    case "sandbox.defaultPids":
    case "sandbox.defaultDiskMib":
    case "sandbox.defaultWallClockMs":
      return isSafeIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER);
    case "budgets.suiteUsdCeilingMicros":
      return value === null || isSafeIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);
    case "comparison.threshold":
      return isSafeIntegerInRange(value, 0, 1_000);
    case "viewer.port":
      return isSafeIntegerInRange(value, 0, 65_535);
  }
}

export function assertLeafValue(
  path: AssayConfigLeafPath,
  value: unknown,
  failure: { readonly code: string; readonly source: string; readonly key: string }
): void {
  if (!isValidLeafValue(path, value)) {
    throw configError(failure.code, failure.source, failure.key, "has an invalid value");
  }
}

export function getConfigLeaf(config: AssayConfig, path: AssayConfigLeafPath): unknown {
  switch (path) {
    case "configVersion": return config.configVersion;
    case "concurrency": return config.concurrency;
    case "runsPerTask": return config.runsPerTask;
    case "defaultAdapter": return config.defaultAdapter;
    case "storePath": return config.storePath;
    case "sandbox.socketPath": return config.sandbox.socketPath;
    case "sandbox.defaultCpus": return config.sandbox.defaultCpus;
    case "sandbox.defaultMemoryMib": return config.sandbox.defaultMemoryMib;
    case "sandbox.defaultPids": return config.sandbox.defaultPids;
    case "sandbox.defaultDiskMib": return config.sandbox.defaultDiskMib;
    case "sandbox.defaultWallClockMs": return config.sandbox.defaultWallClockMs;
    case "budgets.suiteUsdCeilingMicros": return config.budgets.suiteUsdCeilingMicros;
    case "comparison.threshold": return config.comparison.threshold;
    case "comparison.baseline": return config.comparison.baseline;
    case "viewer.port": return config.viewer.port;
    case "redaction.rulesetVersion": return config.redaction.rulesetVersion;
    case "pricingCatalogVersion": return config.pricingCatalogVersion;
  }
}

export function setConfigLeaf(
  config: MutableAssayConfig,
  path: AssayConfigLeafPath,
  value: unknown
): void {
  switch (path) {
    case "configVersion": config.configVersion = value as 1; return;
    case "concurrency": config.concurrency = value as number; return;
    case "runsPerTask": config.runsPerTask = value as number; return;
    case "defaultAdapter": config.defaultAdapter = value as string; return;
    case "storePath": config.storePath = value as string; return;
    case "sandbox.socketPath": config.sandbox.socketPath = value as string | null; return;
    case "sandbox.defaultCpus": config.sandbox.defaultCpus = value as number; return;
    case "sandbox.defaultMemoryMib": config.sandbox.defaultMemoryMib = value as number; return;
    case "sandbox.defaultPids": config.sandbox.defaultPids = value as number; return;
    case "sandbox.defaultDiskMib": config.sandbox.defaultDiskMib = value as number; return;
    case "sandbox.defaultWallClockMs": config.sandbox.defaultWallClockMs = value as number; return;
    case "budgets.suiteUsdCeilingMicros":
      config.budgets.suiteUsdCeilingMicros = value as number | null;
      return;
    case "comparison.threshold": config.comparison.threshold = value as number; return;
    case "comparison.baseline": config.comparison.baseline = value as string | null; return;
    case "viewer.port": config.viewer.port = value as number; return;
    case "redaction.rulesetVersion": config.redaction.rulesetVersion = value as string; return;
    case "pricingCatalogVersion": config.pricingCatalogVersion = value as string; return;
  }
}
