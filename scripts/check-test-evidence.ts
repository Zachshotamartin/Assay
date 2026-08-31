import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type TestEvidenceLane = "unit" | "property" | "integration" | "e2e-simulated";

export interface TestEvidenceRegression {
  readonly file: string;
  readonly title: string;
  readonly requirementId: string;
}

export interface TestEvidenceManifest {
  readonly schemaVersion: 1;
  readonly lanes: Readonly<Record<TestEvidenceLane, readonly string[]>>;
  readonly packagedE2e: readonly string[];
  readonly regressions: readonly TestEvidenceRegression[];
}

export interface TestEvidenceViolation {
  readonly code: string;
  readonly file: string;
  readonly message: string;
}

const LANE_ORDER: readonly TestEvidenceLane[] = [
  "unit",
  "property",
  "integration",
  "e2e-simulated"
];
const REQUIREMENT_ID = /^(?:(?:FR|NFR)-[A-Z0-9]+-[0-9]{3}|[A-Z]+-[0-9]{3}|#[0-9]+)$/u;

function violation(code: string, file: string, message: string): TestEvidenceViolation {
  return { code, file, message };
}

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function isUnitLocation(file: string): boolean {
  return /^(?:apps|packages)\/[^/]+\/src\/.+\.test\.ts$/u.test(file)
    || /^scripts\/[^/]+\.test\.ts$/u.test(file);
}

function isPropertyLocation(file: string): boolean {
  return /^(?:apps|packages)\/[^/]+\/src\/.+\.property\.test\.ts$/u.test(file);
}

function isIntegrationLocation(file: string): boolean {
  return /^(?:apps|packages)\/[^/]+\/test\/integration\/.+\.test\.ts$/u.test(file);
}

function isE2eLocation(file: string): boolean {
  return /^tests\/e2e\/.+\.test\.ts$/u.test(file)
    || /^scripts\/.+-reproducibility\.test\.ts$/u.test(file);
}

function stableViolations(violations: readonly TestEvidenceViolation[]): readonly TestEvidenceViolation[] {
  return [...violations].sort((left, right) =>
    left.file.localeCompare(right.file)
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message));
}

export function validateTestEvidenceSnapshot(
  manifest: TestEvidenceManifest,
  sources: ReadonlyMap<string, string>
): readonly TestEvidenceViolation[] {
  const violations: TestEvidenceViolation[] = [];
  if (manifest.schemaVersion !== 1) {
    violations.push(violation(
      "manifest-schema-version",
      "tests/evidence/r1-test-manifest.json",
      "schemaVersion must be exactly 1"
    ));
  }

  const memberships = new Map<string, TestEvidenceLane[]>();
  for (const lane of LANE_ORDER) {
    const files = manifest.lanes[lane];
    if (!Array.isArray(files)) {
      violations.push(violation(
        "manifest-lane-missing",
        "tests/evidence/r1-test-manifest.json",
        `lane ${lane} must be an array`
      ));
      continue;
    }
    for (const file of files) {
      const lanes = memberships.get(file) ?? [];
      lanes.push(lane);
      memberships.set(file, lanes);
      if (!sources.has(file)) {
        violations.push(violation(
          "test-source-missing",
          file,
          `the ${lane} lane names a file that does not exist`
        ));
      }
    }
  }

  for (const [file, lanes] of memberships) {
    if (lanes.length > 1) {
      violations.push(violation(
        "test-lane-overlap",
        file,
        `test belongs to multiple lanes: ${lanes.join(", ")}`
      ));
    }
  }
  for (const file of sources.keys()) {
    if (!memberships.has(file)) {
      violations.push(violation(
        "test-unclassified",
        file,
        "test is absent from every evidence lane"
      ));
    }
  }

  for (const file of manifest.lanes.unit ?? []) {
    if (!isUnitLocation(file) || file.endsWith(".property.test.ts")) {
      violations.push(violation(
        "unit-test-location",
        file,
        "unit tests must be colocated under a workspace src directory or directly under scripts"
      ));
    }
  }
  for (const file of manifest.lanes.property ?? []) {
    if (!isPropertyLocation(file)) {
      violations.push(violation(
        "property-test-location",
        file,
        "property tests must be colocated with source as *.property.test.ts"
      ));
    }
    const source = sources.get(file);
    if (source !== undefined && !/fc\.assert\s*\([\s\S]*?\bseed\s*:/u.test(source)) {
      violations.push(violation(
        "property-seed-missing",
        file,
        "property tests must pass an explicit replay seed to fast-check"
      ));
    }
  }
  for (const file of manifest.lanes.integration ?? []) {
    if (!isIntegrationLocation(file)) {
      violations.push(violation(
        "integration-test-location",
        file,
        "integration tests must live under a workspace test/integration directory"
      ));
    }
  }
  for (const file of manifest.lanes["e2e-simulated"] ?? []) {
    if (!isE2eLocation(file)) {
      violations.push(violation(
        "packaged-e2e-location",
        file,
        "simulated e2e tests must live under tests/e2e, except repository reproducibility checks"
      ));
    }
  }

  const packaged = new Set(manifest.packagedE2e);
  for (const file of packaged) {
    if (!manifest.lanes["e2e-simulated"].includes(file)) {
      violations.push(violation(
        "packaged-e2e-unclassified",
        file,
        "packaged e2e tests must also belong to the e2e-simulated lane"
      ));
    }
    if (!/^tests\/e2e\/.+\.test\.ts$/u.test(file)) {
      violations.push(violation(
        "packaged-e2e-location",
        file,
        "packaged e2e tests must live under tests/e2e"
      ));
    }
  }

  const regressionKeys = new Set<string>();
  for (const regression of manifest.regressions) {
    const key = `${regression.file}\0${regression.title}`;
    if (regressionKeys.has(key)) {
      violations.push(violation(
        "regression-duplicate",
        regression.file,
        `regression is listed more than once: ${regression.title}`
      ));
    }
    regressionKeys.add(key);

    if (!REQUIREMENT_ID.test(regression.requirementId)) {
      violations.push(violation(
        "regression-id-invalid",
        regression.file,
        `invalid regression requirement or issue id: ${regression.requirementId}`
      ));
    }
    if (!regression.title.includes(regression.requirementId)) {
      violations.push(violation(
        "regression-id-missing",
        regression.file,
        `regression title must contain ${regression.requirementId}`
      ));
    }
    const source = sources.get(regression.file);
    if (source === undefined) {
      violations.push(violation(
        "regression-source-missing",
        regression.file,
        `regression source is unavailable: ${regression.title}`
      ));
    } else if (!source.includes(regression.title)) {
      if (!source.includes(regression.requirementId)) {
        violations.push(violation(
          "regression-id-missing",
          regression.file,
          `regression source title must contain ${regression.requirementId}`
        ));
      }
      violations.push(violation(
        "regression-title-missing",
        regression.file,
        `source does not contain the exact regression title: ${regression.title}`
      ));
    }
  }

  return stableViolations(violations);
}

async function discoverTestSources(repositoryRoot: string): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        sources.set(normalize(relative(repositoryRoot, path)), await readFile(path, "utf8"));
      }
    }
  };

  for (const directory of ["apps", "packages", "scripts", "tests"]) {
    await visit(resolve(repositoryRoot, directory));
  }
  return sources;
}

export async function inspectTestEvidence(
  repositoryRoot: string
): Promise<readonly TestEvidenceViolation[]> {
  const manifestPath = resolve(repositoryRoot, "tests/evidence/r1-test-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TestEvidenceManifest;
  return validateTestEvidenceSnapshot(manifest, await discoverTestSources(repositoryRoot));
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await inspectTestEvidence(repositoryRoot);
  if (violations.length === 0) {
    process.stdout.write("test evidence lanes: ok\n");
    return;
  }
  for (const entry of violations) {
    process.stderr.write(`${entry.file}: ${entry.code}: ${entry.message}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
