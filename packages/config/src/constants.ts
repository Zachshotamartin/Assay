import type { AssayConfig, AssayConfigLeafPath } from "./types.js";

export const MAX_CONFIG_FILE_BYTES = 1_048_576;
export const MAX_CONFIG_DEPTH = 32;
export const MAX_CONFIG_ITEMS = 10_000;
export const MAX_CONFIG_STRING_LENGTH = 4_096;

export const ASSAY_CONFIG_ENV = Object.freeze({
  configVersion: "ASSAY_CONFIG_VERSION",
  concurrency: "ASSAY_CONCURRENCY",
  runsPerTask: "ASSAY_RUNS_PER_TASK",
  defaultAdapter: "ASSAY_DEFAULT_ADAPTER",
  storePath: "ASSAY_STORE_PATH",
  "sandbox.socketPath": "ASSAY_SANDBOX_SOCKET_PATH",
  "sandbox.defaultCpus": "ASSAY_SANDBOX_DEFAULT_CPUS",
  "sandbox.defaultMemoryMib": "ASSAY_SANDBOX_DEFAULT_MEMORY_MIB",
  "sandbox.defaultPids": "ASSAY_SANDBOX_DEFAULT_PIDS",
  "sandbox.defaultDiskMib": "ASSAY_SANDBOX_DEFAULT_DISK_MIB",
  "sandbox.defaultWallClockMs": "ASSAY_SANDBOX_DEFAULT_WALL_CLOCK_MS",
  "budgets.suiteUsdCeilingMicros": "ASSAY_BUDGETS_SUITE_USD_CEILING_MICROS",
  "comparison.threshold": "ASSAY_COMPARISON_THRESHOLD",
  "comparison.baseline": "ASSAY_COMPARISON_BASELINE",
  "viewer.port": "ASSAY_VIEWER_PORT",
  "redaction.rulesetVersion": "ASSAY_REDACTION_RULESET_VERSION",
  pricingCatalogVersion: "ASSAY_PRICING_CATALOG_VERSION"
} as const satisfies Record<AssayConfigLeafPath, `ASSAY_${string}`>);

function freezeConfig(config: AssayConfig): AssayConfig {
  Object.freeze(config.sandbox);
  Object.freeze(config.budgets);
  Object.freeze(config.comparison);
  Object.freeze(config.viewer);
  Object.freeze(config.redaction);
  return Object.freeze(config);
}

export const DEFAULT_ASSAY_CONFIG: AssayConfig = freezeConfig({
  configVersion: 1,
  concurrency: 4,
  runsPerTask: 10,
  defaultAdapter: "adapter-simulated",
  storePath: ".assay",
  sandbox: {
    socketPath: null,
    defaultCpus: 2,
    defaultMemoryMib: 2_048,
    defaultPids: 256,
    defaultDiskMib: 1_024,
    defaultWallClockMs: 600_000
  },
  budgets: {
    suiteUsdCeilingMicros: null
  },
  comparison: {
    threshold: 50,
    baseline: null
  },
  viewer: {
    port: 0
  },
  redaction: {
    rulesetVersion: "2026.08"
  },
  pricingCatalogVersion: "catalog-v1"
});
