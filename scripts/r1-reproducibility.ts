import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tsImport } from "tsx/esm/api";

export const FIXTURE_DIRECTORY_SCHEMA = "assay-fixture-directory/1";
export const REFERENCE_GOLDEN_RELATIVE_PATH = "fixtures/goldens/r1/reference-run.json";
export const REFERENCE_METADATA_RELATIVE_PATH = "fixtures/goldens/r1/metadata.json";

const REFERENCE_SUITE_RELATIVE_PATH = "fixtures/suites/reference.suite.yaml";
const REFERENCE_TREE_RELATIVE_PATH = "fixtures/suites/reference";
const FIXED_WALL_TIME = "2026-08-30T12:00:00.000Z";
const FIXED_ROOT_SEED = 42;
const FIXED_RUN_ID = "01890f70-6c50-7cc8-b2cb-000000000001";

interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface SequenceSource<T extends string> {
  readonly next: () => T;
}

interface ReproducibilityRuntime {
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clock: {
    readonly wallTime: () => string;
    readonly monotonicMilliseconds: () => number;
  };
  readonly runIdSource: SequenceSource<string>;
  readonly taskRunIdSource: SequenceSource<string>;
  readonly eventIdSource: SequenceSource<string>;
  readonly processId: number;
  readonly signal: AbortSignal;
  readonly adapterCommandFor: (adapterId: string) => readonly [string, ...string[]];
}

type ExecuteCli = (
  argv: readonly string[],
  io: CliIo,
  runtime: ReproducibilityRuntime
) => Promise<number>;

type CanonicalJsonBytes = (value: unknown) => Uint8Array;

interface WorkspaceModules {
  readonly executeCli: ExecuteCli;
  readonly canonicalJsonBytes: CanonicalJsonBytes;
}

interface RunRow {
  readonly record_json: string;
  readonly record_hash: string;
}

interface TaskRunRow {
  readonly task_run_id: string;
  readonly record_json: string;
  readonly record_hash: string;
}

interface EventRow {
  readonly event_id: string;
  readonly sequence: number;
  readonly event_json: string;
}

interface CountRow {
  readonly count: number;
}

interface VersionRow {
  readonly version: number;
}

export interface GeneratedFixtureFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

const workspaceModules = new Map<string, Promise<WorkspaceModules>>();

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixedUuid(index: number, middle: "7dd8" | "7ee8"): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999_999_999_999) {
    throw new Error(`fixed identifier index is outside the supported range: ${index}`);
  }
  return `01890f70-6c50-${middle}-b2cb-${String(index).padStart(12, "0")}`;
}

function sequence<T extends string>(values: readonly T[], name: string): SequenceSource<T> {
  let index = 0;
  return {
    next() {
      const value = values[index];
      if (value === undefined) {
        throw new Error(`${name} source exhausted after ${index} identifiers`);
      }
      index += 1;
      return value;
    }
  };
}

function generatedSequence(
  count: number,
  middle: "7dd8" | "7ee8",
  name: string
): SequenceSource<string> {
  return sequence(
    Array.from({ length: count }, (_, index) => fixedUuid(index + 1, middle)),
    name
  );
}

function createFixedRuntime(repositoryRoot: string, projectRoot: string): ReproducibilityRuntime {
  let monotonicMilliseconds = 10_000;
  const simulatedBootstrap = resolve(
    repositoryRoot,
    "packages/adapter-simulated/src/source-bootstrap.mjs"
  );
  const simulatedScenario = resolve(
    repositoryRoot,
    "fixtures/trajectories/happy-multi-turn.json"
  );
  return {
    projectRoot,
    environment: {},
    clock: {
      wallTime: () => FIXED_WALL_TIME,
      monotonicMilliseconds: () => monotonicMilliseconds++
    },
    runIdSource: sequence([FIXED_RUN_ID], "run identifier"),
    taskRunIdSource: generatedSequence(10, "7dd8", "task-run identifier"),
    eventIdSource: generatedSequence(1_000, "7ee8", "event identifier"),
    processId: process.pid,
    signal: new AbortController().signal,
    adapterCommandFor(adapterId) {
      if (adapterId !== "adapter-simulated") {
        throw new Error(`reference run requested unexpected adapter ${JSON.stringify(adapterId)}`);
      }
      return [process.execPath, simulatedBootstrap, simulatedScenario];
    }
  };
}

async function importWorkspaceModules(repositoryRootInput: string): Promise<WorkspaceModules> {
  const repositoryRoot = resolve(repositoryRootInput);
  const existing = workspaceModules.get(repositoryRoot);
  if (existing !== undefined) return await existing;
  const loading = (async (): Promise<WorkspaceModules> => {
    const tsconfig = resolve(repositoryRoot, "scripts/tsconfig.runtime.json");
    const importOptions = { parentURL: import.meta.url, tsconfig } as const;
    const [cliModule, contractsModule] = await Promise.all([
      tsImport(
        pathToFileURL(resolve(repositoryRoot, "apps/cli/src/cli.ts")).href,
        importOptions
      ) as Promise<Readonly<Record<string, unknown>>>,
      tsImport(
        pathToFileURL(resolve(repositoryRoot, "packages/contracts/src/index.ts")).href,
        importOptions
      ) as Promise<Readonly<Record<string, unknown>>>
    ]);
    const executeCli = cliModule["executeCli"];
    const canonicalJsonBytes = contractsModule["canonicalJsonBytes"];
    if (typeof executeCli !== "function") {
      throw new Error("R1 reproducibility harness could not load apps/cli executeCli");
    }
    if (typeof canonicalJsonBytes !== "function") {
      throw new Error("R1 reproducibility harness could not load canonical JSON bytes");
    }
    return {
      executeCli: executeCli as ExecuteCli,
      canonicalJsonBytes: canonicalJsonBytes as CanonicalJsonBytes
    };
  })();
  workspaceModules.set(repositoryRoot, loading);
  try {
    return await loading;
  } catch (cause) {
    workspaceModules.delete(repositoryRoot);
    throw cause;
  }
}

async function copyReferenceProject(repositoryRoot: string, projectRoot: string): Promise<void> {
  await cp(
    resolve(repositoryRoot, REFERENCE_SUITE_RELATIVE_PATH),
    join(projectRoot, "reference.suite.yaml")
  );
  await cp(
    resolve(repositoryRoot, REFERENCE_TREE_RELATIVE_PATH),
    join(projectRoot, "reference"),
    { recursive: true, errorOnExist: true }
  );
}

function verifiedJson(recordJson: string, expectedHash: string, label: string): unknown {
  const actualHash = sha256(recordJson);
  if (actualHash !== expectedHash) {
    throw new Error(`${label} record hash mismatch: expected ${expectedHash}, received ${actualHash}`);
  }
  return JSON.parse(recordJson) as unknown;
}

async function exportStoredRun(
  projectRoot: string,
  canonicalJsonBytes: CanonicalJsonBytes
): Promise<Uint8Array> {
  const database = new DatabaseSync(join(projectRoot, ".assay", "assay.db"));
  try {
    const version = database.prepare("SELECT version FROM schema_meta").get() as VersionRow | undefined;
    if (version?.version !== 1) {
      throw new Error(`reference store schema must be 1, received ${String(version?.version)}`);
    }
    const quarantined = database.prepare(
      "SELECT COUNT(*) AS count FROM quarantine_records"
    ).get() as unknown as CountRow;
    if (quarantined.count !== 0) {
      throw new Error(`reference store contains ${quarantined.count} quarantined records`);
    }

    const runRows = database.prepare(
      "SELECT record_json, record_hash FROM runs ORDER BY run_id"
    ).all() as unknown as readonly RunRow[];
    if (runRows.length !== 1) {
      throw new Error(`reference run must persist exactly one run record, received ${runRows.length}`);
    }
    const runRow = runRows[0]!;
    const run = verifiedJson(runRow.record_json, runRow.record_hash, "run");

    const taskRows = database.prepare(
      "SELECT task_run_id, record_json, record_hash FROM task_runs ORDER BY task_id, attempt, task_run_id"
    ).all() as unknown as readonly TaskRunRow[];
    const taskRuns = taskRows.map((row) =>
      verifiedJson(row.record_json, row.record_hash, `task run ${row.task_run_id}`));

    const eventRows = database.prepare(
      "SELECT event_id, sequence, event_json FROM events ORDER BY sequence"
    ).all() as unknown as readonly EventRow[];
    for (let index = 0; index < eventRows.length; index += 1) {
      if (eventRows[index]!.sequence !== index) {
        throw new Error(
          `reference event sequence must be dense; index ${index} stored ${eventRows[index]!.sequence}`
        );
      }
    }
    const events = eventRows.map((row) => ({
      eventId: row.event_id,
      sequence: row.sequence,
      event: JSON.parse(row.event_json) as unknown
    }));

    const blobHashes = [...new Set(taskRuns.flatMap((record) => {
      if (typeof record !== "object" || record === null || Array.isArray(record)) return [];
      const task = record as Readonly<Record<string, unknown>>;
      return [task["trajectoryBlob"], task["workspaceSnapshot"]]
        .filter((hash): hash is string => typeof hash === "string");
    }))].sort();
    const blobs = [];
    for (const hash of blobHashes) {
      if (!/^[0-9a-f]{64}$/u.test(hash)) {
        throw new Error(`reference task run contains invalid blob hash ${JSON.stringify(hash)}`);
      }
      const bytes = await readFile(join(projectRoot, ".assay", "objects", hash.slice(0, 2), hash));
      const actualHash = sha256(bytes);
      if (actualHash !== hash) {
        throw new Error(`reference blob hash mismatch: expected ${hash}, received ${actualHash}`);
      }
      blobs.push({ hash, bytesBase64: bytes.toString("base64") });
    }

    return canonicalJsonBytes({
      exportVersion: 1,
      storeSchemaVersion: version.version,
      run,
      taskRuns,
      events,
      blobs,
      integrity: {
        runRecordHash: runRow.record_hash,
        taskRunRecordHashes: taskRows.map((row) => ({
          taskRunId: row.task_run_id,
          recordHash: row.record_hash
        }))
      }
    });
  } finally {
    database.close();
  }
}

/**
 * Execute the checked-in simulated suite with injected deterministic runtime
 * inputs and return the complete logical store export. This function never
 * writes a golden; callers that regenerate fixtures live in a separate module.
 */
export async function generateReferenceRunBytes(repositoryRoot: string): Promise<Uint8Array> {
  const projectRoot = await mkdtemp(join(tmpdir(), "assay-r1-repro-"));
  try {
    await copyReferenceProject(repositoryRoot, projectRoot);
    const { canonicalJsonBytes, executeCli } = await importWorkspaceModules(repositoryRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeCli(
      [
        "run",
        "reference.suite.yaml",
        "--variant",
        "baseline",
        "--adapter",
        "simulated",
        "-n",
        "10",
        "--seed",
        String(FIXED_ROOT_SEED)
      ],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text)
      },
      createFixedRuntime(repositoryRoot, projectRoot)
    );
    if (exitCode !== 0) {
      throw new Error(
        `reference suite exited ${exitCode}; stdout=${JSON.stringify(stdout.join(""))}; ` +
        `stderr=${JSON.stringify(stderr.join(""))}`
      );
    }
    return await exportStoredRun(projectRoot, canonicalJsonBytes);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

export async function generateReferenceFixtureFiles(
  repositoryRoot: string
): Promise<readonly GeneratedFixtureFile[]> {
  const goldenBytes = await generateReferenceRunBytes(repositoryRoot);
  const { canonicalJsonBytes } = await importWorkspaceModules(repositoryRoot);
  const manifest = [{ path: "reference-run.json", sha256: sha256(goldenBytes) }];
  const metadata = {
    fixtureSchema: FIXTURE_DIRECTORY_SCHEMA,
    generatorVersion: "r1.14/1",
    contentHash: `sha256:${sha256(canonicalJsonBytes(manifest))}`,
    manifest,
    suites: [REFERENCE_SUITE_RELATIVE_PATH],
    assurances: {
      synthetic: true,
      containsRealCredentials: false,
      containsRealUserRepositories: false,
      containsPrivateTranscripts: false
    },
    regenerationCommand: "npm run fixtures:regen -- fixtures/goldens/r1"
  };
  return [
    { relativePath: "reference-run.json", bytes: goldenBytes },
    { relativePath: "metadata.json", bytes: canonicalJsonBytes(metadata) }
  ];
}
