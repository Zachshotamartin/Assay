import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJsonBytes } from "@assay/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  FIXTURE_DIRECTORY_SCHEMA,
  REFERENCE_GOLDEN_RELATIVE_PATH,
  REFERENCE_METADATA_RELATIVE_PATH,
  generateReferenceRunBytes
} from "./r1-reproducibility.js";
import { selectFixtureDirectories } from "./fixture-regeneration.js";
import { assertGoldenReview } from "./golden-policy.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface FixtureManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

interface FixtureMetadata {
  readonly fixtureSchema: string;
  readonly generatorVersion: string;
  readonly contentHash: string;
  readonly manifest: readonly FixtureManifestEntry[];
  readonly suites: readonly string[];
  readonly assurances: {
    readonly synthetic: boolean;
    readonly containsRealCredentials: boolean;
    readonly containsRealUserRepositories: boolean;
    readonly containsPrivateTranscripts: boolean;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("R1.14 byte reproducibility", () => {
  it("RUN-004 generates full canonical record bytes identically twice and matches the golden", async () => {
    const goldenPath = resolve(repositoryRoot, REFERENCE_GOLDEN_RELATIVE_PATH);
    const goldenBefore = await readFile(goldenPath);
    const metadataBefore = await readFile(resolve(repositoryRoot, REFERENCE_METADATA_RELATIVE_PATH));
    const goldenStatBefore = await stat(goldenPath, { bigint: true });

    const first = await generateReferenceRunBytes(repositoryRoot);
    const second = await generateReferenceRunBytes(repositoryRoot);

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).equals(goldenBefore)).toBe(true);

    const exported = JSON.parse(new TextDecoder().decode(first)) as Readonly<Record<string, unknown>>;
    expect(exported).toMatchObject({
      exportVersion: 1,
      run: {
        seed: 42,
        runsPerTask: 10,
        status: "completed",
        adapterId: "adapter-simulated"
      }
    });
    expect(exported["taskRuns"]).toHaveLength(10);
    expect(exported["events"]).toEqual(expect.any(Array));
    expect(exported["blobs"]).toEqual(expect.any(Array));

    expect(await readFile(goldenPath)).toEqual(goldenBefore);
    expect(await readFile(resolve(repositoryRoot, REFERENCE_METADATA_RELATIVE_PATH)))
      .toEqual(metadataBefore);
    expect((await stat(goldenPath, { bigint: true })).mtimeNs).toBe(goldenStatBefore.mtimeNs);
  }, 120_000);

  it("NFR-MAINT-005 records complete synthetic fixture governance metadata", async () => {
    const metadata = JSON.parse(
      await readFile(resolve(repositoryRoot, REFERENCE_METADATA_RELATIVE_PATH), "utf8")
    ) as FixtureMetadata;

    expect(metadata).toMatchObject({
      fixtureSchema: FIXTURE_DIRECTORY_SCHEMA,
      generatorVersion: "r1.14/1",
      suites: ["fixtures/suites/reference.suite.yaml"],
      assurances: {
        synthetic: true,
        containsRealCredentials: false,
        containsRealUserRepositories: false,
        containsPrivateTranscripts: false
      }
    });
    expect(metadata.manifest).toEqual([
      {
        path: "reference-run.json",
        sha256: sha256(await readFile(resolve(repositoryRoot, REFERENCE_GOLDEN_RELATIVE_PATH)))
      }
    ]);
    expect(metadata.contentHash).toBe(`sha256:${sha256(canonicalJsonBytes(metadata.manifest))}`);
  });

  it("NFR-MAINT-005 exposes only explicit registered fixture regeneration targets", () => {
    expect(selectFixtureDirectories(repositoryRoot, "fixtures/goldens")).toEqual([
      resolve(repositoryRoot, "fixtures/goldens/r1")
    ]);
    expect(selectFixtureDirectories(repositoryRoot, "fixtures/goldens/r1")).toEqual([
      resolve(repositoryRoot, "fixtures/goldens/r1")
    ]);
    expect(() => selectFixtureDirectories(repositoryRoot, "fixtures/suites/reference.suite.yaml"))
      .toThrow(/not a registered generated fixture/u);
    expect(() => selectFixtureDirectories(repositoryRoot, "../outside"))
      .toThrow(/inside the repository/u);
  });

  it("NFR-MAINT-005 wires explicit commands and cross-platform CI without weakening review", async () => {
    const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts?.["fixtures:regen"]).toBe(
      "node --import tsx scripts/fixture-regeneration.ts"
    );
    expect(packageJson.scripts?.["regenerate-goldens"]).toBe(
      "npm run fixtures:regen -- fixtures/goldens"
    );
    expect(packageJson.scripts?.["test:reproducibility"]).toBe(
      "vitest run --workspace vitest.workspace.ts scripts/r1-reproducibility.test.ts"
    );

    const workflow = parse(await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8")) as {
      readonly jobs?: Readonly<Record<string, {
        readonly strategy?: { readonly matrix?: Readonly<Record<string, unknown>> };
        readonly steps?: readonly { readonly run?: string }[];
      }>>;
    };
    const e2e = workflow.jobs?.["e2e-simulated"];
    expect(e2e?.strategy?.matrix?.["os"]).toEqual(["ubuntu-24.04", "macos-14"]);
    expect(e2e?.steps?.some(({ run }) => run === "npm run test:reproducibility")).toBe(true);
    expect(e2e?.steps?.some(({ run }) => run === "npm run check:goldens")).toBe(true);

    expect(() => assertGoldenReview([REFERENCE_GOLDEN_RELATIVE_PATH], "missing note"))
      .toThrow(/semantic review/u);
    expect(() => assertGoldenReview(
      [REFERENCE_GOLDEN_RELATIVE_PATH],
      "Golden semantic review: the fixed reference record is unchanged in meaning"
    )).not.toThrow();
  });
});
