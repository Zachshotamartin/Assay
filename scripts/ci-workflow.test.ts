import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
}

interface WorkflowJob {
  readonly name?: string;
  readonly "runs-on"?: string | Readonly<Record<string, unknown>>;
  readonly strategy?: {
    readonly matrix?: Readonly<Record<string, unknown>>;
  };
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

async function workflow(): Promise<Workflow> {
  return parse(await readFile(workflowPath, "utf8")) as Workflow;
}

describe("R0 CI workflow contract", () => {
  it("runs the four exact required checks on pushes and pull requests", async () => {
    const value = await workflow();

    expect(Object.keys(value.on ?? {}).sort()).toEqual(["pull_request", "push"]);
    for (const name of ["typecheck", "lint-docs", "unit-property", "arch-boundaries"]) {
      expect(value.jobs?.[name]?.name).toBe(name);
      expect(value.jobs?.[name]?.["runs-on"]).toBe("ubuntu-24.04");
    }
  });

  it("pins every Action by a full commit SHA and grants contents read only", async () => {
    const value = await workflow();

    expect(value.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(value.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses !== undefined) {
          expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
        }
      }
    }
  });

  it("uses lockfile-only installs in every job", async () => {
    const value = await workflow();

    for (const [name, job] of Object.entries(value.jobs ?? {})) {
      const installSteps = (job.steps ?? []).filter(({ run }) => run?.includes("npm ci"));
      expect(installSteps, `${name} install step`).toHaveLength(1);
      expect(installSteps[0]?.run).toBe("npm ci --ignore-scripts");
      expect((job.steps ?? []).some(({ run }) => /npm (?:install|i)(?:\s|$)/u.test(run ?? ""))).toBe(
        false
      );
    }
  });

  it("proves the clean-clone bootstrap on pinned Linux and macOS runners", async () => {
    const value = await workflow();

    expect(value.jobs?.["clean-clone-linux"]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(value.jobs?.["clean-clone-macos"]?.["runs-on"]).toBe("macos-14");
    for (const name of ["clean-clone-linux", "clean-clone-macos"]) {
      expect(
        value.jobs?.[name]?.steps?.some(({ run }) => run === "npm run verify")
      ).toBe(true);
    }
  });
});

describe("R1 CI workflow contract", () => {
  it("adds named store-core and cross-platform e2e-simulated required checks", async () => {
    const value = await workflow();

    expect(value.jobs?.["store-core"]?.name).toBe("store-core");
    expect(value.jobs?.["store-core"]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(value.jobs?.["e2e-simulated"]?.name).toBe("e2e-simulated");
    expect(value.jobs?.["e2e-simulated"]?.["runs-on"]).toBe("${{ matrix.os }}");
    expect(value.jobs?.["e2e-simulated"]?.strategy?.matrix?.["os"]).toEqual([
      "ubuntu-24.04",
      "macos-14"
    ]);
  });

  it("enforces the golden semantic-review policy in CI", async () => {
    const value = await workflow();
    const steps = value.jobs?.["e2e-simulated"]?.steps ?? [];

    expect(steps.some(({ run }) => run === "npm run check:goldens")).toBe(true);
  });
});
