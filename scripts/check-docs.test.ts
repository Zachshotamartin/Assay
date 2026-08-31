import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectDocumentation } from "./check-docs.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/repos/${name}/`, import.meta.url));
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface FixtureMutation {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

async function inspectTamperedR1Fixture(
  mutations: readonly FixtureMutation[]
): Promise<Awaited<ReturnType<typeof inspectDocumentation>>> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "assay-docs-r1-"));
  const repository = join(temporaryDirectory, "repository");
  try {
    await cp(fixture("docs-r1-valid"), repository, { recursive: true });
    for (const mutation of mutations) {
      const path = join(repository, mutation.file);
      const source = await readFile(path, "utf8");
      if (!source.includes(mutation.from)) {
        throw new Error(`${mutation.file} does not contain seeded text: ${mutation.from}`);
      }
      await writeFile(path, source.replace(mutation.from, mutation.to), "utf8");
    }
    return await inspectDocumentation(repository);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

describe("documentation consistency checker", () => {
  it("accepts a status-aligned explicitly planned fixture", async () => {
    await expect(inspectDocumentation(fixture("docs-valid"))).resolves.toEqual([]);
  });

  it("rejects a drifted gate status with file and line", async () => {
    await expect(inspectDocumentation(fixture("docs-status-drift"))).resolves.toEqual([
      expect.objectContaining({
        code: "gate-status-drift",
        file: "README.md",
        line: 13,
        gate: "R4"
      })
    ]);
  });

  it("rejects a missing verbatim current-claim block", async () => {
    await expect(inspectDocumentation(fixture("docs-missing-claim"))).resolves.toEqual([
      expect.objectContaining({
        code: "current-claim-missing",
        file: "docs/BUILD_PLAN.md",
        line: 1
      })
    ]);
  });

  it("rejects an unqualified install command for a planned release", async () => {
    await expect(inspectDocumentation(fixture("docs-forbidden-install"))).resolves.toEqual([
      expect.objectContaining({
        code: "forbidden-install-command",
        file: "README.md",
        line: 23
      })
    ]);
  });

  it("accepts the current repository's truthful R1 documentation", async () => {
    await expect(inspectDocumentation(repositoryRoot)).resolves.toEqual([]);
  });

  it("accepts the seeded R1 in-progress documentation fixture", async () => {
    await expect(inspectDocumentation(fixture("docs-r1-valid"))).resolves.toEqual([]);
  });

  it.each([
    ["lockfile-only source install", "npm ci --ignore-scripts", "npm ci"],
    ["source build", "npm run build", "npm run typecheck"],
    [
      "reference validation",
      "node apps/cli/dist/bin.js validate fixtures/suites/reference",
      "node apps/cli/dist/bin.js validate fixtures/suites"
    ],
    [
      "deterministic simulated reference run",
      "node apps/cli/dist/bin.js run fixtures/suites/reference.suite.yaml --variant baseline --adapter simulated -n 10 --seed 42",
      "node apps/cli/dist/bin.js run fixtures/suites/reference.suite.yaml --variant baseline --adapter simulated -n 10 --seed 41"
    ]
  ])("rejects an altered R1 %s command", async (_label, from, to) => {
    await expect(
      inspectTamperedR1Fixture([{ file: "README.md", from, to }])
    ).resolves.toEqual([
      expect.objectContaining({
        code: "r1-quickstart-command-missing",
        file: "README.md"
      })
    ]);
  });

  it.each([
    ["source-only", "source-only preview evidence", "source preview evidence"],
    ["no-isolation", "no sandbox or isolation boundary", "a limited isolation boundary"],
    ["unsafe-host", "`unsafe_host` evidence", "host evidence"],
    [
      "no-real-agent-provider",
      "No real agent or provider is supported",
      "External subjects may be supported"
    ]
  ])("rejects a missing R1 %s boundary", async (boundary, from, to) => {
    await expect(
      inspectTamperedR1Fixture([{ file: "README.md", from, to }])
    ).resolves.toEqual([
      expect.objectContaining({
        code: "r1-boundary-statement-missing",
        file: "README.md",
        message: expect.stringContaining(boundary)
      })
    ]);
  });

  it("rejects R1 status drift from in progress", async () => {
    await expect(
      inspectTamperedR1Fixture([
        {
          file: "README.md",
          from: "| R1 | in progress |",
          to: "| R1 | planned |"
        }
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        code: "gate-status-drift",
        file: "README.md",
        gate: "R1"
      })
    ]);
  });

  it("rejects a synchronized claim that erases R1's unaccepted status [NFR-MAINT-004]", async () => {
    const original =
      "Assay is under implementation. Gate R0 is accepted with repository, toolchain, CI, and GitHub governance evidence. Gate R1 has code and local evidence in progress; gates R2 through R10 remain planned. No evaluation product gate is accepted.";
    const altered =
      "Assay is under implementation. Gates R0 and R1 have code and local evidence on gate branches. R1 product acceptance is pending.";
    await expect(
      inspectTamperedR1Fixture([
        { file: "README.md", from: original, to: altered },
        { file: "docs/BUILD_PLAN.md", from: original, to: altered },
        { file: "docs/status.yaml", from: original, to: altered }
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        code: "r1-status-claim-invalid",
        file: "docs/status.yaml"
      })
    ]);
  });
});
