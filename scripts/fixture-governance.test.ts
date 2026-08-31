import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findPackageLocalFixtureCorpora,
  FIXTURE_DIRECTORY_SCHEMA,
  R1_FIXTURE_GROUPS,
  verifyR1FixtureGovernance
} from "./fixture-governance.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("NFR-MAINT-005 non-golden R1 fixture governance", () => {
  it("declares complete provenance, consumers, assurances, and regeneration instructions", async () => {
    expect(R1_FIXTURE_GROUPS.map((group) => group.fixturePath)).toEqual([
      "fixtures/repos",
      "fixtures/suites/reference",
      "fixtures/trajectories",
      "fixtures/task-format",
      "fixtures/adapter-frames",
      "fixtures/contract-events"
    ]);

    const verified = await verifyR1FixtureGovernance(repositoryRoot);
    expect(verified).toHaveLength(6);
    for (const { group, metadata } of verified) {
      expect(metadata).toMatchObject({
        fixtureSchema: FIXTURE_DIRECTORY_SCHEMA,
        generatorVersion: "r1-fixtures/1",
        fixtureKind: group.fixtureKind,
        manifestRoot: group.manifestRoot,
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
          verificationCommand: "npm run check:fixtures"
        }
      });
      expect(metadata.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(metadata.manifest.length).toBeGreaterThan(0);
      expect(metadata.manifest.map(({ path }) => path)).toEqual(
        [...metadata.manifest.map(({ path }) => path)].sort()
      );
      expect(metadata.consumers.length).toBeGreaterThan(0);
      expect(metadata.regeneration.instructions.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("NFR-MAINT-005 keeps product data fixtures under governed root directories", async () => {
    await expect(findPackageLocalFixtureCorpora(repositoryRoot)).resolves.toEqual([]);

    await expect(readFile(
      join(repositoryRoot, "packages", "run-store", "src", "fixtures", "crash-writer.ts"),
      "utf8"
    )).resolves.toContain("openRunStore");
  });

  it("fails closed when a governed fixture changes without refreshed metadata", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "assay-fixture-governance-"));
    temporaryRoots.push(temporaryRoot);
    await cp(join(repositoryRoot, "fixtures"), join(temporaryRoot, "fixtures"), {
      recursive: true,
      errorOnExist: true
    });

    await expect(verifyR1FixtureGovernance(temporaryRoot)).resolves.toHaveLength(6);
    await appendFile(
      join(temporaryRoot, "fixtures", "trajectories", "happy-multi-turn.json"),
      "\n",
      "utf8"
    );
    await expect(verifyR1FixtureGovernance(temporaryRoot)).rejects.toThrow(
      /fixtures\/trajectories.*metadata drift/u
    );
  });

  it("documents the manual provenance workflow without broadening golden regeneration", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8")
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(packageJson.scripts?.["fixtures:manifest"]).toBe(
      "node --import tsx scripts/fixture-governance.ts refresh"
    );
    expect(packageJson.scripts?.["check:fixtures"]).toBe(
      "node --import tsx scripts/fixture-governance.ts check"
    );
    expect(packageJson.scripts?.["fixtures:regen"]).toBe(
      "node --import tsx scripts/fixture-regeneration.ts"
    );

    const instructions = await readFile(join(repositoryRoot, "fixtures", "README.md"), "utf8");
    for (const group of R1_FIXTURE_GROUPS) {
      expect(instructions).toContain(`npm run fixtures:manifest -- ${group.fixturePath}`);
    }
    expect(instructions).toContain("npm run fixtures:regen -- fixtures/goldens/r1");
    expect(instructions).toContain("Golden semantic review:");
  });
});
