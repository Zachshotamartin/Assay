import { ASSAY_CONFIG_ENV } from "./constants.js";
import { configError } from "./errors.js";
import { assertLeafValue } from "./leaf-values.js";
import type {
  AssayConfigLeafPath,
  ConfigValueSource,
  EnvironmentAccessor
} from "./types.js";

export interface ParsedConfigValues {
  readonly values: Readonly<Partial<Record<AssayConfigLeafPath, unknown>>>;
  readonly sources: Readonly<Partial<Record<AssayConfigLeafPath, ConfigValueSource>>>;
}

const PATH_BY_ENV = new Map<string, AssayConfigLeafPath>(
  Object.entries(ASSAY_CONFIG_ENV).map(([path, envName]) => [envName, path as AssayConfigLeafPath])
);

const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;

function parseInteger(raw: string): number | undefined {
  if (!INTEGER_PATTERN.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseEnvironmentValue(path: AssayConfigLeafPath, raw: string): unknown {
  switch (path) {
    case "configVersion":
    case "concurrency":
    case "runsPerTask":
    case "sandbox.defaultCpus":
    case "sandbox.defaultMemoryMib":
    case "sandbox.defaultPids":
    case "sandbox.defaultDiskMib":
    case "sandbox.defaultWallClockMs":
    case "comparison.threshold":
    case "viewer.port":
      return parseInteger(raw);
    case "budgets.suiteUsdCeilingMicros":
      return raw === "null" ? null : parseInteger(raw);
    case "sandbox.socketPath":
    case "comparison.baseline":
      return raw === "null" ? null : raw;
    case "defaultAdapter":
    case "storePath":
    case "redaction.rulesetVersion":
    case "pricingCatalogVersion":
      return raw;
  }
}

export function environmentFromRecord(
  record: Readonly<Record<string, string | undefined>>
): EnvironmentAccessor {
  const snapshot = Object.freeze(
    Object.entries(record).map(([key, value]) => Object.freeze([key, value] as const))
  );
  return Object.freeze({ entries: () => snapshot });
}

export function parseEnvironment(accessor: EnvironmentAccessor | undefined): ParsedConfigValues {
  if (accessor === undefined) return { values: {}, sources: {} };

  const entries = [...accessor.entries()]
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .filter(([name]) => name.startsWith("ASSAY_"))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  for (const [name] of entries) {
    if (!PATH_BY_ENV.has(name)) {
      throw configError("env-unknown", "environment", name, "is not a recognized Assay setting");
    }
  }

  const values: Partial<Record<AssayConfigLeafPath, unknown>> = {};
  const sources: Partial<Record<AssayConfigLeafPath, ConfigValueSource>> = {};
  for (const [name, raw] of entries) {
    const path = PATH_BY_ENV.get(name) as AssayConfigLeafPath;
    if (Object.hasOwn(values, path)) {
      throw configError("env-duplicate", "environment", name, "was supplied more than once");
    }
    const parsed = parseEnvironmentValue(path, raw);
    assertLeafValue(path, parsed, { code: "env-value", source: "environment", key: name });
    values[path] = parsed;
    sources[path] = Object.freeze({ kind: "env", source: "environment", key: name });
  }

  return { values: Object.freeze(values), sources: Object.freeze(sources) };
}
