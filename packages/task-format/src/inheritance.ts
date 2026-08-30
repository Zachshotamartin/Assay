import { realpath as realpathFromDisk } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  TaskFormatError,
  loadTask,
  type LoadedYaml,
  type TaskDocument
} from "./load-yaml.js";
import { validateTaskDocument } from "./schema.js";

export const MAX_INHERITANCE_FILES = 8;

export interface ResolvedTask extends LoadedYaml<TaskDocument> {
  readonly inheritanceChain: readonly string[];
}

export interface InheritanceOptions {
  readonly projectRoot: string;
  readonly loadTask?: (path: string) => Promise<LoadedYaml<TaskDocument>>;
  readonly realpath?: (path: string) => Promise<string>;
}

class InheritanceError extends TaskFormatError {
  readonly chain: readonly string[];

  constructor(
    code: string,
    filePath: string,
    message: string,
    remedy: string,
    chain: readonly string[],
    cause?: unknown
  ) {
    super(
      {
        category: "task_invalid",
        code,
        filePath,
        yamlPath: "$.extends",
        line: undefined,
        column: undefined,
        remedy
      },
      message,
      cause === undefined ? {} : { cause }
    );
    this.name = "InheritanceError";
    this.chain = [...chain];
  }
}

function own(document: TaskDocument, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(document, key);
}

function isContained(projectRoot: string, candidate: string): boolean {
  const fromRoot = relative(projectRoot, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneValue(nested);
    }
    return clone;
  }
  return value;
}

function asStringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function orderedUnion(...lists: readonly (readonly string[])[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

function shallowMergeMapping(parent: unknown, child: unknown): unknown {
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    return cloneValue(child);
  }
  const parentMapping = typeof parent === "object" && parent !== null && !Array.isArray(parent)
    ? parent as Readonly<Record<string, unknown>>
    : {};
  return {
    ...cloneValue(parentMapping) as Record<string, unknown>,
    ...cloneValue(child) as Record<string, unknown>
  };
}

function mergeDocuments(
  parent: TaskDocument,
  child: TaskDocument,
  childPath: string
): TaskDocument {
  const childIsAbstract = child["abstract"] === true;
  if (!childIsAbstract &&
      (!own(child, "title") || typeof child["title"] !== "string" || child["title"] === "")) {
    throw new InheritanceError(
      "task_invalid/inherited-identity",
      childPath,
      "task_invalid: an extending concrete task must declare its own title",
      "Declare title in the child; title is never inherited.",
      [childPath]
    );
  }

  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!["format_version", "id", "title", "abstract", "extends", "+append:tags"].includes(key)) {
      merged[key] = cloneValue(value);
    }
  }

  for (const [key, value] of Object.entries(child)) {
    if (!["tags", "+append:tags", "budgets", "sandbox", "extends", "abstract"].includes(key)) {
      merged[key] = cloneValue(value);
    }
  }

  const parentTags = asStringList(parent["tags"]);
  const childTags = asStringList(child["tags"]);
  const appendedTags = asStringList(child["+append:tags"]);
  if (own(child, "tags") && own(child, "+append:tags")) {
    throw new InheritanceError(
      "task_invalid/append-conflict",
      childPath,
      "task_invalid: tags and +append:tags cannot appear together",
      "Use tags for child-first union or +append:tags for parent-first append.",
      [childPath]
    );
  }
  if (own(child, "+append:tags")) {
    merged["tags"] = orderedUnion(parentTags, appendedTags);
  } else if (own(child, "tags")) {
    merged["tags"] = orderedUnion(childTags, parentTags);
  } else if (own(parent, "tags")) {
    merged["tags"] = cloneValue(parentTags);
  }

  for (const field of ["budgets", "sandbox"] as const) {
    if (own(child, field)) {
      merged[field] = shallowMergeMapping(parent[field], child[field]);
    }
  }

  merged["format_version"] = cloneValue(child["format_version"]);
  merged["id"] = cloneValue(child["id"]);
  if (own(child, "title")) {
    merged["title"] = cloneValue(child["title"]);
  }
  if (childIsAbstract) {
    merged["abstract"] = true;
  }

  return merged;
}

function validateResolved(document: TaskDocument, filePath: string): void {
  const validation = validateTaskDocument(document);
  if (!validation.ok) {
    throw new InheritanceError(
      validation.code,
      filePath,
      "task_invalid: resolved task does not match the published schema",
      "Make the child and its inherited fields form a valid concrete or abstract task.",
      [filePath]
    );
  }
}

export async function resolveTaskInheritance(
  task: LoadedYaml<TaskDocument>,
  options: InheritanceOptions
): Promise<ResolvedTask> {
  const load = options.loadTask ?? loadTask;
  const canonicalize = options.realpath ?? realpathFromDisk;
  const lexicalProjectRoot = resolve(options.projectRoot);
  let projectRoot: string;
  try {
    projectRoot = await canonicalize(lexicalProjectRoot);
  } catch (error) {
    throw new InheritanceError(
      "task_invalid/path-escape",
      task.path,
      `task_invalid: project root could not be resolved: ${lexicalProjectRoot}`,
      "Pass an existing project root and keep task references inside it.",
      [task.path],
      error
    );
  }

  const visit = async (
    current: LoadedYaml<TaskDocument>,
    traversal: readonly string[]
  ): Promise<ResolvedTask> => {
    const lexicalCurrentPath = resolve(current.path);
    let currentPath: string;
    try {
      currentPath = await canonicalize(lexicalCurrentPath);
    } catch (error) {
      throw new InheritanceError(
        "task_invalid/extends-unresolved",
        lexicalCurrentPath,
        `task_invalid: task path could not be resolved: ${lexicalCurrentPath}`,
        "Correct the task path and ensure the file exists.",
        [...traversal, lexicalCurrentPath],
        error
      );
    }
    if (!isContained(projectRoot, currentPath)) {
      throw new InheritanceError(
        "task_invalid/path-escape",
        lexicalCurrentPath,
        `task_invalid: task resolves outside project root: ${currentPath}`,
        "Keep the task and every extends target inside the real project root.",
        [...traversal, currentPath]
      );
    }
    const cycleStart = traversal.indexOf(currentPath);
    if (cycleStart >= 0) {
      const cycle = [...traversal.slice(cycleStart), currentPath];
      throw new InheritanceError(
        "task_invalid/extends-cycle",
        currentPath,
        `task_invalid: extends cycle detected: ${cycle.join(" -> ")}`,
        "Remove one extends edge so the inheritance graph is acyclic.",
        cycle
      );
    }

    const nextTraversal = [...traversal, currentPath];
    if (nextTraversal.length > MAX_INHERITANCE_FILES) {
      throw new InheritanceError(
        "task_invalid/extends-depth",
        currentPath,
        `task_invalid: extends chain exceeds ${MAX_INHERITANCE_FILES} files: ${nextTraversal.join(" -> ")}`,
        `Reduce the extends chain to at most ${MAX_INHERITANCE_FILES} files.`,
        nextTraversal
      );
    }

    const parentReference = current.document["extends"];
    if (parentReference === undefined) {
      if (own(current.document, "+append:tags")) {
        throw new InheritanceError(
          "task_invalid/append-without-extends",
          currentPath,
          "task_invalid: +append:tags requires extends",
          "Add extends or replace +append:tags with tags.",
          nextTraversal
        );
      }
      validateResolved(current.document, currentPath);
      return {
        path: currentPath,
        source: current.source,
        document: cloneValue(current.document) as TaskDocument,
        inheritanceChain: [currentPath]
      };
    }

    if (typeof parentReference !== "string") {
      throw new InheritanceError(
        "task_invalid/extends-unresolved",
        currentPath,
        "task_invalid: extends must be one relative task path",
        "Set extends to a relative *.task.yaml path.",
        nextTraversal
      );
    }

    if (isAbsolute(parentReference)) {
      throw new InheritanceError(
        "task_invalid/path-escape",
        currentPath,
        `task_invalid: extends must be relative and inside the project: ${parentReference}`,
        "Use a relative *.task.yaml path whose real target is inside the project root.",
        nextTraversal
      );
    }

    const lexicalParentPath = resolve(dirname(currentPath), parentReference);
    if (!isContained(projectRoot, lexicalParentPath)) {
      throw new InheritanceError(
        "task_invalid/path-escape",
        currentPath,
        `task_invalid: extends escapes the project root: ${lexicalParentPath}`,
        "Use a relative *.task.yaml path inside the project root.",
        [...nextTraversal, lexicalParentPath]
      );
    }
    let parentPath: string;
    try {
      parentPath = await canonicalize(lexicalParentPath);
    } catch (error) {
      throw new InheritanceError(
        "task_invalid/extends-unresolved",
        currentPath,
        `task_invalid: extends parent could not be resolved: ${lexicalParentPath}`,
        "Correct the extends path and ensure the parent task exists.",
        [...nextTraversal, lexicalParentPath],
        error
      );
    }
    if (!isContained(projectRoot, parentPath)) {
      throw new InheritanceError(
        "task_invalid/path-escape",
        currentPath,
        `task_invalid: extends target resolves outside the project root: ${parentPath}`,
        "Replace the symlink or extends path with a task inside the real project root.",
        [...nextTraversal, parentPath]
      );
    }
    let parent: LoadedYaml<TaskDocument>;
    try {
      parent = await load(parentPath);
    } catch (error) {
      if (error instanceof TaskFormatError) {
        throw error;
      }
      throw new InheritanceError(
        "task_invalid/extends-unresolved",
        currentPath,
        `task_invalid: extends parent could not be loaded: ${parentPath}`,
        "Correct the extends path and ensure the parent task exists.",
        [...nextTraversal, parentPath],
        error
      );
    }

    const resolvedParent = await visit(parent, nextTraversal);
    const document = mergeDocuments(resolvedParent.document, current.document, currentPath);
    validateResolved(document, currentPath);
    return {
      path: currentPath,
      source: current.source,
      document,
      inheritanceChain: [...resolvedParent.inheritanceChain, currentPath]
    };
  };

  return visit(task, []);
}
