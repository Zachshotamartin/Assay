import { createHash } from "node:crypto";

import { canonicalJsonBytes, createContentHash } from "@assay/contracts";

import { DEFAULT_ASSAY_CONFIG } from "./constants.js";
import { parseEnvironment, type ParsedConfigValues } from "./env.js";
import { configError } from "./errors.js";
import type { MutableAssayConfig } from "./internal-types.js";
import { assertLeafValue, getConfigLeaf, setConfigLeaf } from "./leaf-values.js";
import { validateConfigDocument } from "./schema.js";
import {
  ASSAY_CONFIG_LEAF_PATHS,
  type AssayConfig,
  type AssayConfigLeafPath,
  type AssayConfigOverrides,
  type ConfigSources,
  type ConfigValidationContext,
  type ConfigValueSource,
  type ResolveAssayConfigOptions,
  type ResolvedConfig
} from "./types.js";
import { parseConfigFile } from "./yaml.js";

const NESTED_KEYS = Object.freeze({
  sandbox: new Set(["socketPath", "defaultCpus", "defaultMemoryMib", "defaultPids", "defaultDiskMib", "defaultWallClockMs"]),
  budgets: new Set(["suiteUsdCeilingMicros"]),
  comparison: new Set(["threshold", "baseline"]),
  viewer: new Set(["port"]),
  redaction: new Set(["rulesetVersion"])
} as const);

const TOP_LEVEL_LEAVES = new Set([
  "configVersion",
  "concurrency",
  "runsPerTask",
  "defaultAdapter",
  "storePath",
  "pricingCatalogVersion"
]);

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function parseCliOverrides(overrides: AssayConfigOverrides | undefined): ParsedConfigValues {
  if (overrides === undefined) return { values: {}, sources: {} };
  if (!isPlainRecord(overrides)) {
    throw configError("cli-value", "CLI", "$", "must be a configuration override mapping");
  }

  const values: Partial<Record<AssayConfigLeafPath, unknown>> = {};
  const sources: Partial<Record<AssayConfigLeafPath, ConfigValueSource>> = {};
  for (const key of Object.keys(overrides).sort()) {
    if (TOP_LEVEL_LEAVES.has(key)) {
      const path = key as AssayConfigLeafPath;
      const value = overrides[key];
      assertLeafValue(path, value, { code: "cli-value", source: "CLI", key: path });
      values[path] = value;
      sources[path] = Object.freeze({ kind: "cli", source: "CLI", key: path });
      continue;
    }

    if (!Object.hasOwn(NESTED_KEYS, key)) {
      throw configError("cli-unknown", "CLI", key, "is not a recognized configuration key");
    }
    const nestedValue = overrides[key];
    if (!isPlainRecord(nestedValue)) {
      throw configError("cli-value", "CLI", key, "must be a configuration override mapping");
    }
    const allowed = NESTED_KEYS[key as keyof typeof NESTED_KEYS] as ReadonlySet<string>;
    for (const nestedKey of Object.keys(nestedValue).sort()) {
      const path = `${key}.${nestedKey}`;
      if (!allowed.has(nestedKey)) {
        throw configError("cli-unknown", "CLI", path, "is not a recognized configuration key");
      }
      const typedPath = path as AssayConfigLeafPath;
      const value = nestedValue[nestedKey];
      assertLeafValue(typedPath, value, { code: "cli-value", source: "CLI", key: typedPath });
      values[typedPath] = value;
      sources[typedPath] = Object.freeze({ kind: "cli", source: "CLI", key: typedPath });
    }
  }

  return { values: Object.freeze(values), sources: Object.freeze(sources) };
}

function mutableDefaults(): MutableAssayConfig {
  return {
    configVersion: DEFAULT_ASSAY_CONFIG.configVersion,
    concurrency: DEFAULT_ASSAY_CONFIG.concurrency,
    runsPerTask: DEFAULT_ASSAY_CONFIG.runsPerTask,
    defaultAdapter: DEFAULT_ASSAY_CONFIG.defaultAdapter,
    storePath: DEFAULT_ASSAY_CONFIG.storePath,
    sandbox: { ...DEFAULT_ASSAY_CONFIG.sandbox },
    budgets: { ...DEFAULT_ASSAY_CONFIG.budgets },
    comparison: { ...DEFAULT_ASSAY_CONFIG.comparison },
    viewer: { ...DEFAULT_ASSAY_CONFIG.viewer },
    redaction: { ...DEFAULT_ASSAY_CONFIG.redaction },
    pricingCatalogVersion: DEFAULT_ASSAY_CONFIG.pricingCatalogVersion
  };
}

function defaultSources(): Record<AssayConfigLeafPath, ConfigValueSource> {
  return Object.fromEntries(ASSAY_CONFIG_LEAF_PATHS.map((path) => [
    path,
    Object.freeze({ kind: "default", source: "built-in defaults", key: path })
  ])) as Record<AssayConfigLeafPath, ConfigValueSource>;
}

function applyValues(
  config: MutableAssayConfig,
  sources: Record<AssayConfigLeafPath, ConfigValueSource>,
  parsed: ParsedConfigValues
): void {
  for (const path of ASSAY_CONFIG_LEAF_PATHS) {
    if (!Object.hasOwn(parsed.values, path)) continue;
    setConfigLeaf(config, path, parsed.values[path]);
    const source = parsed.sources[path];
    if (source === undefined) {
      throw configError("source-missing", "configuration resolver", path, "has no winning source");
    }
    sources[path] = source;
  }
}

function freezeConfig(config: MutableAssayConfig): AssayConfig {
  Object.freeze(config.sandbox);
  Object.freeze(config.budgets);
  Object.freeze(config.comparison);
  Object.freeze(config.viewer);
  Object.freeze(config.redaction);
  return Object.freeze(config);
}

function validateCrossFields(config: AssayConfig, context: ConfigValidationContext): void {
  if (config.runsPerTask < 1) {
    throw configError("cross-field", "resolved configuration", "runsPerTask", "must be at least 1");
  }
  if (context.declaredDollarBudget === true && config.budgets.suiteUsdCeilingMicros === null) {
    throw configError(
      "cross-field",
      "task declaration",
      "budgets.suiteUsdCeilingMicros",
      "requires a non-null suite dollar ceiling"
    );
  }
  if (context.unsafeHostExec === true && context.taskNetworkAllowlist === true) {
    throw configError(
      "cross-field",
      "CLI and task declaration",
      "--unsafe-host-exec + network.allowlist",
      "cannot be combined because host execution has no allowlist proxy"
    );
  }
}

function configHash(config: AssayConfig) {
  const digest = createHash("sha256").update(canonicalJsonBytes(config)).digest("hex");
  return createContentHash(digest);
}

export function assayConfigHash(config: AssayConfig) {
  for (const path of ASSAY_CONFIG_LEAF_PATHS) {
    assertLeafValue(path, getConfigLeaf(config, path), {
      code: "resolved-value",
      source: "resolved configuration",
      key: path
    });
  }
  return configHash(config);
}

export function resolveAssayConfig(options: ResolveAssayConfigOptions = {}): ResolvedConfig {
  const fromCli = parseCliOverrides(options.cli);
  const environment = parseEnvironment(options.env);
  const fromFile = options.file === undefined || options.file === null
    ? { values: {}, sources: {} }
    : parseConfigFile(options.file);

  const config = mutableDefaults();
  const sources = defaultSources();
  applyValues(config, sources, fromFile);
  applyValues(config, sources, environment);
  applyValues(config, sources, fromCli);

  const schemaResult = validateConfigDocument(config);
  if (!schemaResult.ok) {
    throw configError("resolved-schema", "resolved configuration", "$", "does not satisfy the configuration schema");
  }
  const frozenConfig = freezeConfig(config);
  validateCrossFields(frozenConfig, options.context ?? {});

  const frozenSources = Object.freeze(sources) as ConfigSources;
  const resolved: ResolvedConfig = {
    config: frozenConfig,
    sources: frozenSources,
    configHash: configHash(frozenConfig)
  };
  return Object.freeze(resolved);
}
