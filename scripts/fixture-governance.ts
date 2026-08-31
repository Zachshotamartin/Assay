import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const FIXTURE_DIRECTORY_SCHEMA = "assay-fixture-directory/1";

type FixtureKind =
  | "repository"
  | "suite"
  | "trajectory"
  | "task-format"
  | "adapter-frame"
  | "contract-event";

export interface R1FixtureGroup {
  readonly id: string;
  readonly fixtureKind: FixtureKind;
  readonly fixturePath: string;
  readonly metadataPath: string;
  readonly manifestRoot: string;
  readonly sourcePaths: readonly string[];
  readonly suites: readonly string[];
  readonly consumers: readonly string[];
}

interface FixtureManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

export interface FixtureGovernanceMetadata {
  readonly fixtureSchema: typeof FIXTURE_DIRECTORY_SCHEMA;
  readonly generatorVersion: "r1-fixtures/1";
  readonly fixtureId: string;
  readonly fixtureKind: FixtureKind;
  readonly manifestRoot: string;
  readonly contentHash: string;
  readonly manifest: readonly FixtureManifestEntry[];
  readonly suites: readonly string[];
  readonly consumers: readonly string[];
  readonly assurances: {
    readonly synthetic: true;
    readonly containsRealCredentials: false;
    readonly containsRealUserRepositories: false;
    readonly containsPrivateTranscripts: false;
    readonly registeredSyntheticCanaries: readonly string[];
  };
  readonly provenance: {
    readonly origin: "repository-authored-synthetic";
    readonly source: "Assay R1 planning and test corpus";
    readonly license: "MIT";
    readonly capturedFromExternalSystem: false;
  };
  readonly regeneration: {
    readonly mode: "hand-authored";
    readonly command: string;
    readonly verificationCommand: "npm run check:fixtures";
    readonly instructions: readonly string[];
  };
}

export interface VerifiedFixtureGroup {
  readonly group: R1FixtureGroup;
  readonly metadata: FixtureGovernanceMetadata;
}

export const R1_FIXTURE_GROUPS: readonly R1FixtureGroup[] = Object.freeze([
  Object.freeze({
    id: "r1-repository-test-corpus",
    fixtureKind: "repository",
    fixturePath: "fixtures/repos",
    metadataPath: "fixtures/repos/metadata.json",
    manifestRoot: "fixtures/repos",
    sourcePaths: ["."],
    suites: [],
    consumers: [
      "scripts/check-architecture.test.ts",
      "scripts/check-docs.test.ts"
    ]
  }),
  Object.freeze({
    id: "r1-reference-suite",
    fixtureKind: "suite",
    fixturePath: "fixtures/suites/reference",
    metadataPath: "fixtures/suites/reference/metadata.json",
    manifestRoot: "fixtures/suites",
    sourcePaths: ["reference.suite.yaml", "reference"],
    suites: ["fixtures/suites/reference.suite.yaml"],
    consumers: [
      ".github/workflows/ci.yml",
      "scripts/r1-reproducibility.ts"
    ]
  }),
  Object.freeze({
    id: "r1-simulated-trajectory-corpus",
    fixtureKind: "trajectory",
    fixturePath: "fixtures/trajectories",
    metadataPath: "fixtures/trajectories/metadata.json",
    manifestRoot: "fixtures/trajectories",
    sourcePaths: ["."],
    suites: [],
    consumers: [
      "apps/cli/src/run.e2e.test.ts",
      "packages/adapter-simulated/src/scenario.test.ts",
      "packages/adapter-simulated/src/subprocess.test.ts"
    ]
  }),
  Object.freeze({
    id: "r1-task-format-corpus",
    fixtureKind: "task-format",
    fixturePath: "fixtures/task-format",
    metadataPath: "fixtures/task-format/metadata.json",
    manifestRoot: "fixtures/task-format",
    sourcePaths: ["."],
    suites: [],
    consumers: [
      "packages/task-format/src/load-yaml.test.ts",
      "packages/task-format/src/matrix.test.ts",
      "packages/task-format/src/resolve-suite.test.ts",
      "packages/task-format/src/schemas/schema-corpus.test.ts",
      "packages/task-format/src/schemas/schema-fixtures.test.ts"
    ]
  }),
  Object.freeze({
    id: "r1-adapter-frame-corpus",
    fixtureKind: "adapter-frame",
    fixturePath: "fixtures/adapter-frames",
    metadataPath: "fixtures/adapter-frames/metadata.json",
    manifestRoot: "fixtures/adapter-frames",
    sourcePaths: ["."],
    suites: [],
    consumers: ["packages/adapter-core/src/frames/codec.test.ts"]
  }),
  Object.freeze({
    id: "r1-contract-event-corpus",
    fixtureKind: "contract-event",
    fixturePath: "fixtures/contract-events",
    metadataPath: "fixtures/contract-events/metadata.json",
    manifestRoot: "fixtures/contract-events",
    sourcePaths: ["."],
    suites: [],
    consumers: ["packages/contracts/src/events.test.ts"]
  })
]);

const PACKAGE_FIXTURE_DIRECTORY_NAMES = new Set(["fixtures", "scenarios"]);
const PACKAGE_FIXTURE_DIRECTORY_IGNORES = new Set(["dist", "node_modules"]);
const ALLOWED_PACKAGE_FIXTURE_HELPERS = new Set([
  "packages/run-store/src/fixtures/crash-writer.ts"
]);

function pathOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function isWithin(parentInput: string, childInput: string): boolean {
  const parent = resolve(parentInput);
  const child = resolve(childInput);
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function containsDisallowedFixtureFile(
  repositoryRoot: string,
  directory: string
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => pathOrder(left.name, right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory()) {
      if (await containsDisallowedFixtureFile(repositoryRoot, path)) return true;
      continue;
    }
    if (
      !entry.isFile() ||
      !ALLOWED_PACKAGE_FIXTURE_HELPERS.has(slash(relative(repositoryRoot, path)))
    ) {
      return true;
    }
  }
  return false;
}

async function findFixtureDirectories(
  repositoryRoot: string,
  directory: string,
  found: string[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  entries.sort((left, right) => pathOrder(left.name, right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || PACKAGE_FIXTURE_DIRECTORY_IGNORES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (PACKAGE_FIXTURE_DIRECTORY_NAMES.has(entry.name)) {
      if (await containsDisallowedFixtureFile(repositoryRoot, path)) {
        found.push(slash(relative(repositoryRoot, path)));
      }
      continue;
    }
    await findFixtureDirectories(repositoryRoot, path, found);
  }
}

export async function findPackageLocalFixtureCorpora(
  repositoryRootInput: string
): Promise<readonly string[]> {
  const repositoryRoot = resolve(repositoryRootInput);
  const found: string[] = [];
  await findFixtureDirectories(repositoryRoot, resolve(repositoryRoot, "apps"), found);
  await findFixtureDirectories(repositoryRoot, resolve(repositoryRoot, "packages"), found);
  return found.sort(pathOrder);
}

async function collectFiles(
  manifestRoot: string,
  sourcePath: string,
  metadataPath: string,
  paths: Set<string>
): Promise<void> {
  const absolute = resolve(manifestRoot, sourcePath);
  if (!isWithin(manifestRoot, absolute)) {
    throw new Error(`fixture source path escapes its manifest root: ${sourcePath}`);
  }
  if (absolute === metadataPath) return;
  const status = await lstat(absolute);
  if (status.isSymbolicLink()) {
    throw new Error(`governed fixtures may not contain symbolic links: ${absolute}`);
  }
  if (status.isDirectory()) {
    const entries = await readdir(absolute);
    entries.sort(pathOrder);
    for (const entry of entries) {
      await collectFiles(manifestRoot, relative(manifestRoot, resolve(absolute, entry)), metadataPath, paths);
    }
    return;
  }
  if (!status.isFile()) {
    throw new Error(`governed fixture path is not a regular file: ${absolute}`);
  }
  paths.add(slash(relative(manifestRoot, absolute)));
}

async function fixtureManifest(
  repositoryRoot: string,
  group: R1FixtureGroup
): Promise<readonly FixtureManifestEntry[]> {
  const manifestRoot = resolve(repositoryRoot, group.manifestRoot);
  const metadataPath = resolve(repositoryRoot, group.metadataPath);
  if (!isWithin(repositoryRoot, manifestRoot) || !isWithin(repositoryRoot, metadataPath)) {
    throw new Error(`fixture group ${group.id} escapes the repository`);
  }
  const paths = new Set<string>();
  for (const sourcePath of group.sourcePaths) {
    await collectFiles(manifestRoot, sourcePath, metadataPath, paths);
  }
  const manifest: FixtureManifestEntry[] = [];
  for (const path of [...paths].sort(pathOrder)) {
    manifest.push({
      path,
      sha256: sha256(await readFile(resolve(manifestRoot, path)))
    });
  }
  if (manifest.length === 0) {
    throw new Error(`fixture group ${group.id} has an empty manifest`);
  }
  return manifest;
}

async function expectedMetadata(
  repositoryRoot: string,
  group: R1FixtureGroup
): Promise<FixtureGovernanceMetadata> {
  const manifest = await fixtureManifest(repositoryRoot, group);
  return {
    fixtureSchema: FIXTURE_DIRECTORY_SCHEMA,
    generatorVersion: "r1-fixtures/1",
    fixtureId: group.id,
    fixtureKind: group.fixtureKind,
    manifestRoot: group.manifestRoot,
    contentHash: `sha256:${sha256(JSON.stringify(manifest))}`,
    manifest,
    suites: group.suites,
    consumers: group.consumers,
    assurances: {
      synthetic: true,
      containsRealCredentials: false,
      containsRealUserRepositories: false,
      containsPrivateTranscripts: false,
      registeredSyntheticCanaries: []
    },
    provenance: {
      origin: "repository-authored-synthetic",
      source: "Assay R1 planning and test corpus",
      license: "MIT",
      capturedFromExternalSystem: false
    },
    regeneration: {
      mode: "hand-authored",
      command: `npm run fixtures:manifest -- ${group.fixturePath}`,
      verificationCommand: "npm run check:fixtures",
      instructions: [
        "Edit only synthetic fixture source files and preserve the documented schema.",
        `Refresh this manifest with npm run fixtures:manifest -- ${group.fixturePath}.`,
        "Review every content and provenance change, then run npm run check:fixtures."
      ]
    }
  };
}

function parseMetadata(text: string, path: string): FixtureGovernanceMetadata {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("metadata root must be an object");
    }
    return value as FixtureGovernanceMetadata;
  } catch (cause) {
    throw new Error(`${path} is not valid fixture governance JSON`, { cause });
  }
}

export async function verifyR1FixtureGovernance(
  repositoryRootInput: string
): Promise<readonly VerifiedFixtureGroup[]> {
  const repositoryRoot = resolve(repositoryRootInput);
  const packageLocalCorpora = await findPackageLocalFixtureCorpora(repositoryRoot);
  if (packageLocalCorpora.length > 0) {
    throw new Error(
      `product data fixture corpora must live under fixtures/: ${packageLocalCorpora.join(", ")}`
    );
  }
  const verified: VerifiedFixtureGroup[] = [];
  for (const group of R1_FIXTURE_GROUPS) {
    const metadataPath = resolve(repositoryRoot, group.metadataPath);
    let actual: FixtureGovernanceMetadata;
    try {
      const status = await lstat(metadataPath);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error("metadata must be a regular non-symbolic file");
      }
      actual = parseMetadata(await readFile(metadataPath, "utf8"), group.metadataPath);
    } catch (cause) {
      throw new Error(`${group.fixturePath} metadata drift: ${group.metadataPath} is unavailable`, {
        cause
      });
    }
    const expected = await expectedMetadata(repositoryRoot, group);
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `${group.fixturePath} metadata drift: run npm run fixtures:manifest -- ${group.fixturePath}`
      );
    }
    verified.push({ group, metadata: actual });
  }
  return verified;
}

let temporaryCounter = 0;

async function atomicWrite(path: string, text: string): Promise<void> {
  temporaryCounter += 1;
  const temporaryPath = `${path}.tmp-${process.pid}-${temporaryCounter}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try {
    await rename(temporaryPath, path);
  } catch (cause) {
    await rm(temporaryPath, { force: true });
    throw cause;
  }
}

export async function refreshR1FixtureGovernance(
  repositoryRootInput: string,
  requestedPath: string
): Promise<string> {
  const repositoryRoot = resolve(repositoryRootInput);
  const group = R1_FIXTURE_GROUPS.find(({ fixturePath }) => fixturePath === slash(requestedPath));
  if (group === undefined) {
    throw new Error(`fixture manifest path is not registered: ${requestedPath}`);
  }
  const metadata = await expectedMetadata(repositoryRoot, group);
  await atomicWrite(
    resolve(repositoryRoot, group.metadataPath),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  return group.metadataPath;
}

async function main(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const [command, requestedPath, ...extra] = process.argv.slice(2);
  if (command === "check" && requestedPath === undefined && extra.length === 0) {
    const verified = await verifyR1FixtureGovernance(repositoryRoot);
    process.stdout.write(`fixture governance: ok (${verified.length} groups)\n`);
    return;
  }
  if (command === "refresh" && requestedPath !== undefined && extra.length === 0) {
    const written = await refreshR1FixtureGovernance(repositoryRoot, requestedPath);
    process.stdout.write(`refreshed ${written}; semantic review is required\n`);
    return;
  }
  throw new Error(
    "usage: fixture-governance check | fixture-governance refresh <registered fixture path>"
  );
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
