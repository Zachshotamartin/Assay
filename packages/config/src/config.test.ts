import { readFile } from "node:fs/promises";

import { AssayError, canonicalJson } from "@assay/contracts";
import { describe, expect, it } from "vitest";

import {
  ASSAY_CONFIG_ENV,
  ASSAY_CONFIG_LEAF_PATHS,
  DEFAULT_ASSAY_CONFIG,
  MAX_CONFIG_DEPTH,
  MAX_CONFIG_FILE_BYTES,
  MAX_CONFIG_ITEMS,
  ConfigError,
  environmentFromRecord,
  resolveAssayConfig,
  type AssayConfig,
  type AssayConfigOverrides,
  type ConfigFileInput,
  type EnvironmentAccessor
} from "./index.js";

const encoder = new TextEncoder();

function file(source: string, path = "/work/assay.config.yaml"): ConfigFileInput {
  return { path, bytes: encoder.encode(source) };
}

function expectConfigError(
  action: () => unknown,
  expected: {
    readonly code: string;
    readonly source: string;
    readonly key: string;
    readonly line?: number;
    readonly column?: number;
  }
): ConfigError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toBeInstanceOf(AssayError);
    const actual = error as ConfigError;
    expect(actual.category).toBe("invalid_configuration");
    expect(actual.code).toBe(expected.code);
    expect(actual.source).toBe(expected.source);
    expect(actual.key).toBe(expected.key);
    if (expected.line !== undefined) expect(actual.line).toBe(expected.line);
    if (expected.column !== undefined) expect(actual.column).toBe(expected.column);
    expect(actual.message).toContain("invalid_configuration:");
    expect(actual.message).toContain(expected.source);
    expect(actual.message).toContain(expected.key);
    return actual;
  }
  throw new Error("expected ConfigError");
}

describe("Assay configuration schema and defaults", () => {
  it("publishes the complete Architecture section 12 defaults", () => {
    expect(DEFAULT_ASSAY_CONFIG).toEqual({
      configVersion: 1,
      concurrency: 4,
      runsPerTask: 10,
      defaultAdapter: "adapter-simulated",
      storePath: ".assay",
      sandbox: {
        socketPath: null,
        defaultCpus: 2,
        defaultMemoryMib: 2048,
        defaultPids: 256,
        defaultDiskMib: 1024,
        defaultWallClockMs: 600_000
      },
      budgets: { suiteUsdCeilingMicros: null },
      comparison: { threshold: 50, baseline: null },
      viewer: { port: 0 },
      redaction: { rulesetVersion: "2026.08" },
      pricingCatalogVersion: "catalog-v1"
    });
    expect(Object.isFrozen(DEFAULT_ASSAY_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ASSAY_CONFIG.sandbox)).toBe(true);
  });

  it("documents one mechanical ASSAY_* mapping for every leaf in the schema", async () => {
    const schema = JSON.parse(
      await readFile(new URL("./schemas/assay-config.v1.schema.json", import.meta.url), "utf8")
    ) as {
      readonly properties: Readonly<Record<string, unknown>>;
      readonly [key: string]: unknown;
    };

    expect(ASSAY_CONFIG_LEAF_PATHS).toHaveLength(17);
    expect(new Set(ASSAY_CONFIG_LEAF_PATHS).size).toBe(17);
    expect(Object.keys(ASSAY_CONFIG_ENV).sort()).toEqual([...ASSAY_CONFIG_LEAF_PATHS].sort());
    expect(schema["x-assay-env-mapping"]).toEqual(
      Object.fromEntries(
        Object.entries(ASSAY_CONFIG_ENV).map(([configPath, envName]) => [envName, configPath])
      )
    );
  });
});

describe("CFG-001 precedence and immutable provenance", () => {
  it("resolves CLI over env over YAML over defaults with a source for every leaf", () => {
    const resolved = resolveAssayConfig({
      file: file(`configVersion: 1
concurrency: 2
runsPerTask: 3
defaultAdapter: file-adapter
storePath: .file-assay
sandbox:
  socketPath: /file/docker.sock
  defaultCpus: 3
  defaultMemoryMib: 3072
  defaultPids: 300
  defaultDiskMib: 1536
  defaultWallClockMs: 700000
budgets:
  suiteUsdCeilingMicros: 5000000
comparison:
  threshold: 120
  baseline: file-main
viewer:
  port: 3000
redaction:
  rulesetVersion: "2026.09"
pricingCatalogVersion: catalog-file
`),
      env: environmentFromRecord({
        ASSAY_CONCURRENCY: "5",
        ASSAY_SANDBOX_SOCKET_PATH: "/env/docker.sock",
        ASSAY_COMPARISON_THRESHOLD: "80",
        ASSAY_VIEWER_PORT: "4000"
      }),
      cli: {
        concurrency: 6,
        defaultAdapter: "cli-adapter",
        comparison: { threshold: 50 }
      }
    });

    expect(resolved.config.concurrency).toBe(6);
    expect(resolved.config.defaultAdapter).toBe("cli-adapter");
    expect(resolved.config.comparison.threshold).toBe(50);
    expect(resolved.config.sandbox.socketPath).toBe("/env/docker.sock");
    expect(resolved.config.viewer.port).toBe(4000);
    expect(resolved.config.runsPerTask).toBe(3);
    expect(resolved.config.budgets.suiteUsdCeilingMicros).toBe(5_000_000);

    expect(resolved.sources["concurrency"]).toMatchObject({
      kind: "cli", source: "CLI", key: "concurrency"
    });
    expect(resolved.sources["sandbox.socketPath"]).toMatchObject({
      kind: "env", source: "environment", key: "ASSAY_SANDBOX_SOCKET_PATH"
    });
    expect(resolved.sources["runsPerTask"]).toMatchObject({
      kind: "file", source: "/work/assay.config.yaml", key: "runsPerTask", line: 3
    });
    expect(resolved.sources["sandbox.defaultCpus"]).toMatchObject({
      kind: "file", source: "/work/assay.config.yaml", key: "sandbox.defaultCpus", line: 8
    });
    expect(resolved.sources["pricingCatalogVersion"]).toMatchObject({
      kind: "file", source: "/work/assay.config.yaml", key: "pricingCatalogVersion"
    });

    const fromDefaults = resolveAssayConfig();
    expect(Object.keys(fromDefaults.sources).sort()).toEqual([...ASSAY_CONFIG_LEAF_PATHS].sort());
    expect(fromDefaults.sources["sandbox.defaultDiskMib"]).toEqual({
      kind: "default",
      source: "built-in defaults",
      key: "sandbox.defaultDiskMib"
    });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.config)).toBe(true);
    expect(Object.isFrozen(resolved.config.sandbox)).toBe(true);
    expect(Object.isFrozen(resolved.sources)).toBe(true);
    expect(Object.isFrozen(resolved.sources["concurrency"])).toBe(true);
    expect(() => {
      (resolved.config.sandbox as { defaultCpus: number }).defaultCpus = 99;
    }).toThrow(TypeError);
    expect(resolved.config.sandbox.defaultCpus).toBe(3);
  });

  it("parses every documented environment override mechanically", () => {
    const resolved = resolveAssayConfig({
      env: environmentFromRecord({
        ASSAY_CONFIG_VERSION: "1",
        ASSAY_CONCURRENCY: "7",
        ASSAY_RUNS_PER_TASK: "12",
        ASSAY_DEFAULT_ADAPTER: "environment-adapter",
        ASSAY_STORE_PATH: ".environment-store",
        ASSAY_SANDBOX_SOCKET_PATH: "/environment/docker.sock",
        ASSAY_SANDBOX_DEFAULT_CPUS: "4",
        ASSAY_SANDBOX_DEFAULT_MEMORY_MIB: "4096",
        ASSAY_SANDBOX_DEFAULT_PIDS: "400",
        ASSAY_SANDBOX_DEFAULT_DISK_MIB: "2048",
        ASSAY_SANDBOX_DEFAULT_WALL_CLOCK_MS: "900000",
        ASSAY_BUDGETS_SUITE_USD_CEILING_MICROS: "7000000",
        ASSAY_COMPARISON_THRESHOLD: "100",
        ASSAY_COMPARISON_BASELINE: "main",
        ASSAY_VIEWER_PORT: "8080",
        ASSAY_REDACTION_RULESET_VERSION: "2026.10",
        ASSAY_PRICING_CATALOG_VERSION: "catalog-environment"
      })
    });

    expect(resolved.config).toEqual({
      configVersion: 1,
      concurrency: 7,
      runsPerTask: 12,
      defaultAdapter: "environment-adapter",
      storePath: ".environment-store",
      sandbox: {
        socketPath: "/environment/docker.sock",
        defaultCpus: 4,
        defaultMemoryMib: 4096,
        defaultPids: 400,
        defaultDiskMib: 2048,
        defaultWallClockMs: 900_000
      },
      budgets: { suiteUsdCeilingMicros: 7_000_000 },
      comparison: { threshold: 100, baseline: "main" },
      viewer: { port: 8080 },
      redaction: { rulesetVersion: "2026.10" },
      pricingCatalogVersion: "catalog-environment"
    });
    for (const path of ASSAY_CONFIG_LEAF_PATHS) {
      expect(resolved.sources[path].kind).toBe("env");
      expect(resolved.sources[path].key).toBe(ASSAY_CONFIG_ENV[path]);
    }
  });

  it("uses the config value alone for a canonical, source-independent hash", () => {
    const fromFile = resolveAssayConfig({ file: file("configVersion: 1\nconcurrency: 8\n") });
    const fromEnv = resolveAssayConfig({
      env: environmentFromRecord({ ASSAY_CONCURRENCY: "8" })
    });
    const changed = resolveAssayConfig({
      env: environmentFromRecord({ ASSAY_CONCURRENCY: "9" })
    });

    expect(fromFile.configHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(fromFile.configHash).toBe(fromEnv.configHash);
    expect(fromFile.configHash).not.toBe(changed.configHash);
    expect(canonicalJson(fromFile.config)).toBe(canonicalJson(fromEnv.config));
  });
});

describe("CFG-002 fail-fast source-aware validation", () => {
  it("rejects unknown ASSAY_* names without exposing their values", () => {
    const secret = "canary-secret-value-that-must-not-appear";
    const error = expectConfigError(
      () => resolveAssayConfig({
        env: environmentFromRecord({ ASSAY_OPENAI_API_KEY: secret })
      }),
      {
        code: "invalid_configuration/env-unknown",
        source: "environment",
        key: "ASSAY_OPENAI_API_KEY"
      }
    );
    expect(error.message).not.toContain(secret);
  });

  it("enumerates injected environment access rather than reading process.env", () => {
    let entriesCalls = 0;
    const env: EnvironmentAccessor = {
      entries() {
        entriesCalls += 1;
        return [["ASSAY_CONCURRENCY", "11"]] as const;
      }
    };
    expect(resolveAssayConfig({ env }).config.concurrency).toBe(11);
    expect(entriesCalls).toBe(1);
  });

  it("rejects unknown YAML keys with exact nested key and file position", () => {
    expectConfigError(
      () => resolveAssayConfig({
        file: file("configVersion: 1\nsandbox:\n  surpriseLimit: 3\n")
      }),
      {
        code: "invalid_configuration/file-schema",
        source: "/work/assay.config.yaml",
        key: "sandbox.surpriseLimit",
        line: 3,
        column: 18
      }
    );
  });

  it("rejects unknown versions and wrong types with the offending source and key", () => {
    expectConfigError(
      () => resolveAssayConfig({ file: file("configVersion: 2\n") }),
      {
        code: "invalid_configuration/version-unsupported",
        source: "/work/assay.config.yaml",
        key: "configVersion",
        line: 1
      }
    );
    expectConfigError(
      () => resolveAssayConfig({ file: file("configVersion: 1\nconcurrency: many\n") }),
      {
        code: "invalid_configuration/file-schema",
        source: "/work/assay.config.yaml",
        key: "concurrency",
        line: 2
      }
    );
    expectConfigError(
      () => resolveAssayConfig({
        env: environmentFromRecord({ ASSAY_CONCURRENCY: "many" })
      }),
      {
        code: "invalid_configuration/env-value",
        source: "environment",
        key: "ASSAY_CONCURRENCY"
      }
    );
  });

  it("validates env before parsing the YAML file, matching startup order", () => {
    expectConfigError(
      () => resolveAssayConfig({
        env: environmentFromRecord({ ASSAY_TYPO: "1" }),
        file: file("not: [valid")
      }),
      {
        code: "invalid_configuration/env-unknown",
        source: "environment",
        key: "ASSAY_TYPO"
      }
    );
  });

  it("validates already-parsed CLI overrides before env and file inputs", () => {
    expectConfigError(
      () => resolveAssayConfig({
        cli: { concurrency: 0 },
        env: environmentFromRecord({ ASSAY_TYPO: "1" }),
        file: file("not: [valid")
      }),
      {
        code: "invalid_configuration/cli-value",
        source: "CLI",
        key: "concurrency"
      }
    );
  });

  it("requires a version marker whenever a configuration file exists", () => {
    expectConfigError(
      () => resolveAssayConfig({ file: file("concurrency: 3\n") }),
      {
        code: "invalid_configuration/file-schema",
        source: "/work/assay.config.yaml",
        key: "configVersion",
        line: 1
      }
    );
  });

  it("rejects duplicate YAML keys and root non-mappings with positions", () => {
    expectConfigError(
      () => resolveAssayConfig({
        file: file("configVersion: 1\nconcurrency: 2\nconcurrency: 3\n")
      }),
      {
        code: "invalid_configuration/yaml-parse",
        source: "/work/assay.config.yaml",
        key: "$",
        line: 3
      }
    );
    expectConfigError(
      () => resolveAssayConfig({ file: file("- configVersion\n- 1\n") }),
      {
        code: "invalid_configuration/file-schema",
        source: "/work/assay.config.yaml",
        key: "$",
        line: 1
      }
    );
  });

  it("enforces byte, depth, and item bounds before resolution", () => {
    expectConfigError(
      () => resolveAssayConfig({
        file: {
          path: "/work/oversize.yaml",
          bytes: new Uint8Array(MAX_CONFIG_FILE_BYTES + 1)
        }
      }),
      {
        code: "invalid_configuration/file-too-large",
        source: "/work/oversize.yaml",
        key: "$"
      }
    );

    let deeplyNested = "configVersion: 1\nextra:";
    for (let depth = 0; depth <= MAX_CONFIG_DEPTH; depth += 1) deeplyNested += "\n" + "  ".repeat(depth + 1) + "level:";
    deeplyNested += " value\n";
    expectConfigError(
      () => resolveAssayConfig({ file: file(deeplyNested, "/work/deep.yaml") }),
      {
        code: "invalid_configuration/depth-limit",
        source: "/work/deep.yaml",
        key: "$"
      }
    );

    const manyItems = ["configVersion: 1", ...Array.from(
      { length: MAX_CONFIG_ITEMS + 1 },
      (_, index) => `unknown${index}: ${index}`
    )].join("\n");
    expectConfigError(
      () => resolveAssayConfig({ file: file(manyItems, "/work/many.yaml") }),
      {
        code: "invalid_configuration/item-limit",
        source: "/work/many.yaml",
        key: "$"
      }
    );
  });

  it("rejects unknown CLI override keys and invalid ranges without echoing values", () => {
    expectConfigError(
      () => resolveAssayConfig({
        cli: { concurrency: 65 } as AssayConfigOverrides
      }),
      {
        code: "invalid_configuration/cli-value",
        source: "CLI",
        key: "concurrency"
      }
    );
    expectConfigError(
      () => resolveAssayConfig({
        cli: { credential: "do-not-print" } as unknown as AssayConfigOverrides
      }),
      {
        code: "invalid_configuration/cli-unknown",
        source: "CLI",
        key: "credential"
      }
    );
  });
});

describe("cross-field validation", () => {
  it("requires at least one run per task", () => {
    expectConfigError(
      () => resolveAssayConfig({ cli: { runsPerTask: 0 } }),
      {
        code: "invalid_configuration/cli-value",
        source: "CLI",
        key: "runsPerTask"
      }
    );
  });

  it("requires a suite dollar ceiling when a task declares a dollar budget", () => {
    expectConfigError(
      () => resolveAssayConfig({ context: { declaredDollarBudget: true } }),
      {
        code: "invalid_configuration/cross-field",
        source: "task declaration",
        key: "budgets.suiteUsdCeilingMicros"
      }
    );
    expect(() => resolveAssayConfig({
      cli: { budgets: { suiteUsdCeilingMicros: 5_000_000 } },
      context: { declaredDollarBudget: true }
    })).not.toThrow();
  });

  it("rejects unsafe host execution with a task network allowlist", () => {
    expectConfigError(
      () => resolveAssayConfig({
        context: { unsafeHostExec: true, taskNetworkAllowlist: true }
      }),
      {
        code: "invalid_configuration/cross-field",
        source: "CLI and task declaration",
        key: "--unsafe-host-exec + network.allowlist"
      }
    );
  });
});

describe("null environment encoding", () => {
  it("accepts literal null only for nullable leaves", () => {
    const resolved = resolveAssayConfig({
      file: file(`configVersion: 1
sandbox:
  socketPath: /file/docker.sock
budgets:
  suiteUsdCeilingMicros: 100
comparison:
  baseline: main
`),
      env: environmentFromRecord({
        ASSAY_SANDBOX_SOCKET_PATH: "null",
        ASSAY_BUDGETS_SUITE_USD_CEILING_MICROS: "null",
        ASSAY_COMPARISON_BASELINE: "null"
      })
    });
    expect(resolved.config.sandbox.socketPath).toBeNull();
    expect(resolved.config.budgets.suiteUsdCeilingMicros).toBeNull();
    expect(resolved.config.comparison.baseline).toBeNull();
  });

  it("does not reinterpret empty strings as null", () => {
    expectConfigError(
      () => resolveAssayConfig({
        env: environmentFromRecord({ ASSAY_COMPARISON_BASELINE: "" })
      }),
      {
        code: "invalid_configuration/env-value",
        source: "environment",
        key: "ASSAY_COMPARISON_BASELINE"
      }
    );
  });
});

void ({} as AssayConfig);
