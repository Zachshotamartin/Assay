import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { canonicalJson } from "@assay/contracts";
import { describe, expect, it } from "vitest";

import {
  loadSuite,
  resolveSuite,
  taskContentHash,
  toTaggedHashTree,
  type LoadedYaml,
  type SuiteDocument,
  type TaskDocument
} from "./index.js";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const projectRoot = fileURLToPath(
  new URL("../fixtures/suite-resolution/", import.meta.url)
);
const suitePath = fileURLToPath(
  new URL("../fixtures/suite-resolution/core.suite.yaml", import.meta.url)
);

function concreteTask(id: string, tags: readonly string[] = []): TaskDocument {
  return {
    format_version: "1.0",
    id,
    title: id,
    tags,
    fixture: { path: "./fixture" },
    prompt: "Run it.",
    toolset: { catalog: "simulated/1" },
    sandbox: { image: `example.invalid/fixture@sha256:${digest}` },
    assertions: [{ type: "exit_code", equals: 0 }]
  };
}

function loadedTask(path: string, document: TaskDocument): LoadedYaml<TaskDocument> {
  return { path, source: "", document };
}

const suiteDocument: SuiteDocument = {
  format_version: "1.0",
  id: "test-suite",
  title: "Test suite",
  include: ["tasks/**/*.task.yaml"],
  variants: {
    baseline: { adapter: "simulated", model: "synthetic/deterministic-1" }
  }
};

describe("suite resolution and canonical content hashes", () => {
  it("resolves real glob paths, filters tags, and orders by path then id", async () => {
    const suite = await loadSuite(suitePath);
    const resolved = await resolveSuite(suite, { projectRoot });

    expect(resolved.tasks.map((task) => task.document["id"])).toEqual([
      "zeta-task",
      "alpha-task"
    ]);
    expect(resolved.tasks.every((task) => /^[0-9a-f]{64}$/u.test(task.contentHash))).toBe(true);
    expect(resolved.suiteContentHash).toBe(
      createHash("sha256")
        .update(canonicalJson(resolved.tasks.map((task) => task.contentHash)))
        .digest("hex")
    );
  });

  it("is invariant to filesystem match ordering", async () => {
    const suite: LoadedYaml<SuiteDocument> = {
      path: "/project/core.suite.yaml",
      source: "",
      document: suiteDocument
    };
    const paths = ["/project/tasks/z.task.yaml", "/project/tasks/a.task.yaml"];
    const tasks: Readonly<Record<string, LoadedYaml<TaskDocument>>> = {
      [paths[0]!]: loadedTask(paths[0]!, concreteTask("alpha-task", ["selected"])),
      [paths[1]!]: loadedTask(paths[1]!, concreteTask("zeta-task", ["selected"]))
    };
    const resolveWith = (matches: readonly string[]) => resolveSuite(suite, {
      projectRoot: "/project",
      expandInclude: async () => matches,
      loadTask: async (path) => tasks[path]!
    });

    const forward = await resolveWith(paths);
    const reverse = await resolveWith([...paths].reverse());

    expect(forward.tasks.map((task) => task.path)).toEqual([
      "/project/tasks/a.task.yaml",
      "/project/tasks/z.task.yaml"
    ]);
    expect(reverse.tasks.map((task) => task.path)).toEqual(
      forward.tasks.map((task) => task.path)
    );
    expect(reverse.suiteContentHash).toBe(forward.suiteContentHash);
  });

  it("rejects duplicate ids and names both defining files", async () => {
    const suite: LoadedYaml<SuiteDocument> = {
      path: "/project/core.suite.yaml",
      source: "",
      document: suiteDocument
    };
    const paths = ["/project/tasks/a.task.yaml", "/project/tasks/b.task.yaml"];

    await expect(resolveSuite(suite, {
      projectRoot: "/project",
      expandInclude: async () => paths,
      loadTask: async (path) => loadedTask(path, concreteTask("duplicate-task"))
    })).rejects.toMatchObject({
      category: "suite_invalid",
      code: "suite_invalid/duplicate-id",
      taskId: "duplicate-task",
      definingPaths: paths
    });
  });

  it("silently skips abstract glob matches but rejects a directly named abstract task", async () => {
    const abstract = loadedTask("/project/tasks/base.task.yaml", {
      format_version: "1.0",
      id: "base-task",
      abstract: true
    });
    const baseSuite: LoadedYaml<SuiteDocument> = {
      path: "/project/core.suite.yaml",
      source: "",
      document: suiteDocument
    };

    await expect(resolveSuite(baseSuite, {
      projectRoot: "/project",
      expandInclude: async () => [abstract.path],
      loadTask: async () => abstract
    })).rejects.toMatchObject({ code: "suite_invalid/empty" });

    const directSuite = {
      ...baseSuite,
      document: { ...suiteDocument, include: ["tasks/base.task.yaml"] }
    };
    await expect(resolveSuite(directSuite, {
      projectRoot: "/project",
      expandInclude: async () => [abstract.path],
      loadTask: async () => abstract
    })).rejects.toMatchObject({ code: "suite_invalid/abstract-direct" });
  });

  it("uses a fully type-tagged numeric projection without collisions", () => {
    expect(taskContentHash({ value: 0.5 })).not.toBe(
      taskContentHash({ value: { type: "number", value: "0.5" } })
    );
    expect(taskContentHash({ value: 1 })).toBe(taskContentHash({ value: 1.0 }));
    expect(taskContentHash({ a: 0.5, b: true })).toBe(
      taskContentHash({ b: true, a: 0.5 })
    );
    expect(toTaggedHashTree(0.5)).toEqual({ type: "number", value: "0.5" });
  });
});
