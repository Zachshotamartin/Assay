import type { ContentHash } from "@assay/contracts";

export interface AssayConfig {
  readonly configVersion: 1;
  readonly concurrency: number;
  readonly runsPerTask: number;
  readonly defaultAdapter: string;
  readonly storePath: string;
  readonly sandbox: {
    readonly socketPath: string | null;
    readonly defaultCpus: number;
    readonly defaultMemoryMib: number;
    readonly defaultPids: number;
    readonly defaultDiskMib: number;
    readonly defaultWallClockMs: number;
  };
  readonly budgets: {
    readonly suiteUsdCeilingMicros: number | null;
  };
  readonly comparison: {
    readonly threshold: number;
    readonly baseline: string | null;
  };
  readonly viewer: {
    readonly port: number;
  };
  readonly redaction: {
    readonly rulesetVersion: string;
  };
  readonly pricingCatalogVersion: string;
}

export interface AssayConfigOverrides {
  readonly configVersion?: 1;
  readonly concurrency?: number;
  readonly runsPerTask?: number;
  readonly defaultAdapter?: string;
  readonly storePath?: string;
  readonly sandbox?: {
    readonly socketPath?: string | null;
    readonly defaultCpus?: number;
    readonly defaultMemoryMib?: number;
    readonly defaultPids?: number;
    readonly defaultDiskMib?: number;
    readonly defaultWallClockMs?: number;
  };
  readonly budgets?: {
    readonly suiteUsdCeilingMicros?: number | null;
  };
  readonly comparison?: {
    readonly threshold?: number;
    readonly baseline?: string | null;
  };
  readonly viewer?: {
    readonly port?: number;
  };
  readonly redaction?: {
    readonly rulesetVersion?: string;
  };
  readonly pricingCatalogVersion?: string;
}

const CONFIG_LEAF_PATHS = [
  "configVersion",
  "concurrency",
  "runsPerTask",
  "defaultAdapter",
  "storePath",
  "sandbox.socketPath",
  "sandbox.defaultCpus",
  "sandbox.defaultMemoryMib",
  "sandbox.defaultPids",
  "sandbox.defaultDiskMib",
  "sandbox.defaultWallClockMs",
  "budgets.suiteUsdCeilingMicros",
  "comparison.threshold",
  "comparison.baseline",
  "viewer.port",
  "redaction.rulesetVersion",
  "pricingCatalogVersion"
] as const;

export const ASSAY_CONFIG_LEAF_PATHS = Object.freeze(CONFIG_LEAF_PATHS);

export type AssayConfigLeafPath = (typeof ASSAY_CONFIG_LEAF_PATHS)[number];

export type ConfigSourceKind = "default" | "file" | "env" | "cli";

export interface ConfigValueSource {
  readonly kind: ConfigSourceKind;
  readonly source: string;
  readonly key: string;
  readonly line?: number;
  readonly column?: number;
}

export type ConfigSources = Readonly<
  Record<AssayConfigLeafPath, ConfigValueSource>
>;

export interface ResolvedConfig {
  readonly config: AssayConfig;
  readonly sources: ConfigSources;
  readonly configHash: ContentHash;
}

export interface EnvironmentAccessor {
  readonly entries: () => Iterable<readonly [string, string | undefined]>;
}

export interface ConfigFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ConfigValidationContext {
  readonly declaredDollarBudget?: boolean;
  readonly unsafeHostExec?: boolean;
  readonly taskNetworkAllowlist?: boolean;
}

export interface ResolveAssayConfigOptions {
  readonly cli?: AssayConfigOverrides;
  readonly env?: EnvironmentAccessor;
  readonly file?: ConfigFileInput | null;
  readonly context?: ConfigValidationContext;
}
