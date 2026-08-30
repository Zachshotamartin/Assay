import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TaskFormatError,
  resolveTaskInheritance,
  validateTaskDocument,
  type LoadedYaml,
  type TaskDocument
} from "./index.js";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function loaded(path: string, document: TaskDocument): LoadedYaml<TaskDocument> {
  return { path, source: "", document };
}

function fixtureLoader(
  entries: Readonly<Record<string, TaskDocument>>
): (path: string) => Promise<LoadedYaml<TaskDocument>> {
  return async (path) => {
    const document = entries[path];
    if (document === undefined) {
      const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return loaded(path, document);
  };
}

function inheritanceOptions(
  entries: Readonly<Record<string, TaskDocument>>,
  realpath: (path: string) => Promise<string> = async (path) => path
) {
  return {
    projectRoot: "/project",
    realpath,
    loadTask: fixtureLoader(entries)
  };
}

const abstractParent: TaskDocument = {
  format_version: "1.0",
  id: "parent-task",
  abstract: true,
  description: "parent description",
  tags: ["parent", "shared"],
  fixture: { path: "./parent-fixture" },
  prompt: "parent prompt",
  toolset: { catalog: "simulated/1", allow: ["read_file"] },
  sandbox: {
    image: `example.invalid/fixture@sha256:${digest}`,
    network: "none",
    memory_mb: 1024
  },
  assertions: [{ type: "exit_code", equals: 0 }],
  budgets: {
    dollars: { limit: 1, aggregate: "median", scope: "task" },
    tokens: { limit: 100, aggregate: "median", scope: "task" }
  },
  run_policy: { n: 10, seed: 7 }
};

const concreteChild: TaskDocument = {
  format_version: "1.0",
  id: "child-task",
  title: "Concrete child",
  extends: "./parent.task.yaml",
  description: "child description",
  tags: ["child", "shared"],
  fixture: { path: "./child-fixture" },
  prompt: "child prompt",
  toolset: { catalog: "simulated/1", allow: ["write_file"] },
  sandbox: { memory_mb: 2048 },
  assertions: [{ type: "file_exists", path: "result.txt" }],
  budgets: {
    tokens: { limit: 200, aggregate: "p95", scope: "task" }
  }
};

describe("single-parent task inheritance", () => {
  it("applies every BUILD_PLAN merge rule field by field", async () => {
    const childPath = "/project/tasks/child.task.yaml";
    const parentPath = "/project/tasks/parent.task.yaml";
    expect(validateTaskDocument(concreteChild)).toEqual({ ok: true });

    const result = await resolveTaskInheritance(
      loaded(childPath, concreteChild),
      inheritanceOptions({ [parentPath]: abstractParent })
    );

    expect(result.inheritanceChain).toEqual([parentPath, childPath]);
    expect(result.document).toMatchObject({
      format_version: "1.0",
      id: "child-task",
      title: "Concrete child",
      description: "child description",
      tags: ["child", "shared", "parent"],
      fixture: { path: "./child-fixture" },
      prompt: "child prompt",
      toolset: { catalog: "simulated/1", allow: ["write_file"] },
      sandbox: {
        image: `example.invalid/fixture@sha256:${digest}`,
        network: "none",
        memory_mb: 2048
      },
      assertions: [{ type: "file_exists", path: "result.txt" }],
      budgets: {
        dollars: { limit: 1, aggregate: "median", scope: "task" },
        tokens: { limit: 200, aggregate: "p95", scope: "task" }
      },
      run_policy: { n: 10, seed: 7 }
    });
    expect(result.document).not.toHaveProperty("extends");
    expect(result.document).not.toHaveProperty("abstract");
  });

  it("honors the literal +append:tags operation and removes its control key", async () => {
    const childPath = "/project/tasks/child.task.yaml";
    const parentPath = "/project/tasks/parent.task.yaml";
    const { tags: _tags, ...childWithoutTags } = concreteChild;
    const child = {
      ...childWithoutTags,
      "+append:tags": ["child"]
    } as TaskDocument;

    const result = await resolveTaskInheritance(
      loaded(childPath, child),
      inheritanceOptions({ [parentPath]: abstractParent })
    );

    expect(result.document["tags"]).toEqual(["parent", "shared", "child"]);
    expect(result.document).not.toHaveProperty("+append:tags");
  });

  it.each([
    ["self", {
      "/project/self.task.yaml": {
        format_version: "1.0",
        id: "self-task",
        title: "Self",
        extends: "./self.task.yaml"
      }
    }, ["/project/self.task.yaml", "/project/self.task.yaml"]],
    ["two-node", {
      "/project/a.task.yaml": {
        format_version: "1.0",
        id: "task-a",
        title: "A",
        extends: "./b.task.yaml"
      },
      "/project/b.task.yaml": {
        format_version: "1.0",
        id: "task-b",
        title: "B",
        extends: "./a.task.yaml"
      }
    }, ["/project/a.task.yaml", "/project/b.task.yaml", "/project/a.task.yaml"]]
  ] as const)("rejects a %s cycle and names its traversal chain", async (_name, entries, expectedChain) => {
    const firstPath = Object.keys(entries)[0] as string;

    try {
      await resolveTaskInheritance(
        loaded(firstPath, entries[firstPath] as TaskDocument),
        inheritanceOptions(entries)
      );
      throw new Error("expected cycle rejection");
    } catch (error) {
      expect(error).toMatchObject({
        category: "task_invalid",
        code: "task_invalid/extends-cycle",
        chain: expectedChain
      });
      expect((error as Error).message).toContain(expectedChain.join(" -> "));
    }
  });

  it("rejects inheritance deeper than eight files", async () => {
    const entries: Record<string, TaskDocument> = {};
    for (let index = 0; index < 9; index += 1) {
      const path = `/project/task-${index}.task.yaml`;
      entries[path] = {
        format_version: "1.0",
        id: `task-${index}`,
        title: `Task ${index}`,
        ...(index < 8 ? { extends: `./task-${index + 1}.task.yaml` } : { abstract: true })
      };
    }

    await expect(
      resolveTaskInheritance(
        loaded("/project/task-0.task.yaml", entries["/project/task-0.task.yaml"]!),
        inheritanceOptions(entries)
      )
    ).rejects.toMatchObject({
      category: "task_invalid",
      code: "task_invalid/extends-depth"
    });
  });

  it("maps a missing parent to extends-unresolved and keeps id/title child-owned", async () => {
    await expect(
      resolveTaskInheritance(
        loaded("/project/child.task.yaml", {
          format_version: "1.0",
          id: "child-task",
          title: "Child",
          extends: "./missing.task.yaml"
        }),
        inheritanceOptions({})
      )
    ).rejects.toMatchObject({
      category: "task_invalid",
      code: "task_invalid/extends-unresolved"
    });

    expect(resolve("/project", "./missing.task.yaml")).toBe("/project/missing.task.yaml");
  });

  it("never inherits a concrete child's id or title", async () => {
    const { title: _title, ...childWithoutTitle } = concreteChild;
    await expect(
      resolveTaskInheritance(
        loaded("/project/tasks/child.task.yaml", childWithoutTitle),
        inheritanceOptions({
          "/project/tasks/parent.task.yaml": {
            ...abstractParent,
            title: "Parent title must not leak"
          }
        })
      )
    ).rejects.toMatchObject({
      category: "task_invalid",
      code: "task_invalid/inherited-identity"
    });
  });

  it.each([
    ["absolute", "/outside/parent.task.yaml"],
    ["lexical", "../../outside/parent.task.yaml"]
  ] as const)("rejects an %s extends escape before reading it", async (_kind, parentReference) => {
    const child = loaded("/project/tasks/child.task.yaml", {
      format_version: "1.0",
      id: "child-task",
      title: "Child",
      extends: parentReference
    });

    await expect(
      resolveTaskInheritance(child, inheritanceOptions({}))
    ).rejects.toMatchObject({
      category: "task_invalid",
      code: "task_invalid/path-escape"
    });
  });

  it("rejects an in-root symlink whose real target escapes the project", async () => {
    const childPath = "/project/tasks/child.task.yaml";
    const linkPath = "/project/tasks/link.task.yaml";
    const child = loaded(childPath, {
      format_version: "1.0",
      id: "child-task",
      title: "Child",
      extends: "./link.task.yaml"
    });
    const realpath = async (path: string): Promise<string> =>
      path === linkPath ? "/outside/parent.task.yaml" : path;

    await expect(
      resolveTaskInheritance(child, inheritanceOptions({}, realpath))
    ).rejects.toMatchObject({
      category: "task_invalid",
      code: "task_invalid/path-escape"
    });
  });
});
