import { readdir, realpath as realpathFromDisk, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { suiteContentHash, taskContentHash } from "./content-hash.js";
import { resolveTaskInheritance } from "./inheritance.js";
import {
  loadMatrix,
  loadTask,
  TaskFormatError,
  type LoadedYaml,
  type MatrixDocument,
  type SuiteDocument,
  type TaskDocument
} from "./load-yaml.js";
import { expandMatrix } from "./matrix.js";

const EXCLUDED_DISCOVERY_DIRECTORIES = new Set([".assay", ".git", "node_modules"]);

export interface SuiteWarning {
  readonly code: "suite_warning/include-glob-unmatched";
  readonly include: string;
  readonly message: string;
}

export interface HashedResolvedTask extends LoadedYaml<TaskDocument> {
  readonly contentHash: string;
}

export interface ResolvedSuite {
  readonly suite: LoadedYaml<SuiteDocument>;
  readonly tasks: readonly HashedResolvedTask[];
  readonly suiteContentHash: string;
  readonly warnings: readonly SuiteWarning[];
}

export type IncludeExpander = (
  suitePath: string,
  include: string,
  projectRoot: string
) => Promise<readonly string[]>;

export interface SuiteResolutionOptions {
  readonly projectRoot: string;
  readonly realpath?: (path: string) => Promise<string>;
  readonly expandInclude?: IncludeExpander;
  readonly loadTask?: (path: string) => Promise<LoadedYaml<TaskDocument>>;
  readonly loadMatrix?: (path: string) => Promise<LoadedYaml<MatrixDocument>>;
}

class SuiteResolutionError extends TaskFormatError {
  readonly taskId: string | undefined;
  readonly definingPaths: readonly string[] | undefined;

  constructor(
    code: string,
    suitePath: string,
    yamlPath: string,
    detail: string,
    remedy: string,
    duplicate?: { readonly taskId: string; readonly definingPaths: readonly string[] }
  ) {
    super(
      {
        category: "suite_invalid",
        code,
        filePath: suitePath,
        yamlPath,
        line: undefined,
        column: undefined,
        remedy
      },
      `suite_invalid: ${detail}`
    );
    this.name = "SuiteResolutionError";
    this.taskId = duplicate?.taskId;
    this.definingPaths = duplicate?.definingPaths;
  }
}

function suiteFailure(
  codeSuffix: string,
  suitePath: string,
  yamlPath: string,
  detail: string,
  remedy: string,
  duplicate?: { readonly taskId: string; readonly definingPaths: readonly string[] }
): SuiteResolutionError {
  return new SuiteResolutionError(
    `suite_invalid/${codeSuffix}`,
    suitePath,
    yamlPath,
    detail,
    remedy,
    duplicate
  );
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const count = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < count; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function isContained(projectRoot: string, candidate: string): boolean {
  const fromRoot = relative(projectRoot, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function isGlob(include: string): boolean {
  return include.includes("*");
}

function validateIncludeSyntax(include: string, suitePath: string, index: number): void {
  if (include.includes("\\") || include.includes("?") || /[\[\]]/u.test(include)) {
    throw suiteFailure(
      "include-syntax",
      suitePath,
      `$.include[${index}]`,
      `suite include uses unsupported glob syntax: ${include}`,
      "Use forward slashes with literal paths, * within one segment, or ** across segments."
    );
  }
  if (isAbsolute(include)) {
    throw suiteFailure(
      "path-escape",
      suitePath,
      `$.include[${index}]`,
      `suite include must be relative: ${include}`,
      "Use a relative include whose real target stays inside the project root."
    );
  }
}

function staticPrefix(include: string): string {
  const wildcard = include.indexOf("*");
  const prefix = wildcard < 0 ? include : include.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash < 0 ? "." : prefix.slice(0, slash + 1);
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u");
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => codePointCompare(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DISCOVERY_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

export async function expandSuiteInclude(
  suitePath: string,
  include: string,
  projectRoot: string
): Promise<readonly string[]> {
  const suiteDirectory = dirname(resolve(suitePath));
  if (!isGlob(include)) {
    const candidate = resolve(suiteDirectory, include);
    try {
      const metadata = await stat(candidate);
      return metadata.isFile() ? [candidate] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  const matcher = globRegex(include);
  const files = await walkFiles(projectRoot);
  return files
    .filter((path) => matcher.test(relative(suiteDirectory, path).split(sep).join("/")))
    .sort(codePointCompare);
}

interface DiscoveredPath {
  readonly path: string;
  readonly direct: boolean;
}

function taskMatchesTags(
  document: TaskDocument,
  selector: unknown
): boolean {
  if (typeof selector !== "object" || selector === null || Array.isArray(selector)) {
    return true;
  }
  const tags = new Set(
    Array.isArray(document["tags"])
      ? document["tags"].filter((tag): tag is string => typeof tag === "string")
      : []
  );
  const record = selector as Readonly<Record<string, unknown>>;
  const anyOf = Array.isArray(record["any_of"]) ? record["any_of"] as readonly string[] : undefined;
  const allOf = Array.isArray(record["all_of"]) ? record["all_of"] as readonly string[] : undefined;
  const noneOf = Array.isArray(record["none_of"]) ? record["none_of"] as readonly string[] : undefined;
  return (anyOf === undefined || anyOf.some((tag) => tags.has(tag))) &&
    (allOf === undefined || allOf.every((tag) => tags.has(tag))) &&
    (noneOf === undefined || noneOf.every((tag) => !tags.has(tag)));
}

export async function resolveSuite(
  suite: LoadedYaml<SuiteDocument>,
  options: SuiteResolutionOptions
): Promise<ResolvedSuite> {
  const canonicalize = options.realpath ?? realpathFromDisk;
  const expandInclude = options.expandInclude ?? expandSuiteInclude;
  const readTask = options.loadTask ?? loadTask;
  const readMatrix = options.loadMatrix ?? loadMatrix;
  const lexicalRoot = resolve(options.projectRoot);
  const projectRoot = await canonicalize(lexicalRoot);
  const lexicalSuitePath = resolve(suite.path);
  const suitePath = await canonicalize(lexicalSuitePath);
  if (!isContained(projectRoot, suitePath)) {
    throw suiteFailure(
      "path-escape",
      lexicalSuitePath,
      "$",
      `suite resolves outside the project root: ${suitePath}`,
      "Place the suite inside the real project root."
    );
  }

  const includeValue = suite.document["include"];
  const includes = Array.isArray(includeValue)
    ? includeValue.filter((entry): entry is string => typeof entry === "string")
    : [];
  const warnings: SuiteWarning[] = [];
  const discovered = new Map<string, DiscoveredPath>();

  for (const [index, include] of includes.entries()) {
    validateIncludeSyntax(include, suitePath, index);
    const prefix = resolve(dirname(suitePath), staticPrefix(include));
    if (!isContained(projectRoot, prefix)) {
      throw suiteFailure(
        "path-escape",
        suitePath,
        `$.include[${index}]`,
        `suite include escapes the project root: ${include}`,
        "Use a relative include whose lexical and real targets stay inside the project root."
      );
    }
    const matches = await expandInclude(suitePath, include, projectRoot);
    if (matches.length === 0) {
      if (isGlob(include)) {
        warnings.push({
          code: "suite_warning/include-glob-unmatched",
          include,
          message: `suite include glob matched no files: ${include}`
        });
        continue;
      }
      throw suiteFailure(
        "include-unmatched",
        suitePath,
        `$.include[${index}]`,
        `suite include path matched no file: ${include}`,
        "Correct the path or remove the direct include."
      );
    }

    for (const matched of [...matches].sort(codePointCompare)) {
      const lexicalMatch = resolve(matched);
      if (!isContained(projectRoot, lexicalMatch)) {
        throw suiteFailure(
          "path-escape",
          suitePath,
          `$.include[${index}]`,
          `suite include matched a path outside the project root: ${lexicalMatch}`,
          "Constrain the include to files inside the project root."
        );
      }
      const realMatch = await canonicalize(lexicalMatch);
      if (!isContained(projectRoot, realMatch)) {
        throw suiteFailure(
          "path-escape",
          suitePath,
          `$.include[${index}]`,
          `suite include target resolves outside the project root: ${realMatch}`,
          "Remove the escaping symlink or select an in-project file."
        );
      }
      const prior = discovered.get(realMatch);
      discovered.set(realMatch, {
        path: realMatch,
        direct: (prior?.direct ?? false) || !isGlob(include)
      });
    }
  }

  const resolvedTasks: LoadedYaml<TaskDocument>[] = [];
  const discoveredPaths = [...discovered.values()].sort((left, right) =>
    codePointCompare(left.path, right.path)
  );
  for (const discoveredPath of discoveredPaths) {
    if (discoveredPath.path.endsWith(".task.yaml")) {
      const rawTask = await readTask(discoveredPath.path);
      const task = await resolveTaskInheritance(rawTask, {
        projectRoot,
        realpath: canonicalize,
        loadTask: readTask
      });
      if (task.document["abstract"] === true) {
        if (discoveredPath.direct) {
          throw suiteFailure(
            "abstract-direct",
            suitePath,
            "$.include",
            `suite directly includes abstract task ${discoveredPath.path}`,
            "Include a concrete child or select the abstract parent only through a glob."
          );
        }
        continue;
      }
      resolvedTasks.push(task);
      continue;
    }

    if (discoveredPath.path.endsWith(".matrix.yaml")) {
      const matrix = await readMatrix(discoveredPath.path);
      const baseLexical = resolve(dirname(discoveredPath.path), matrix.document.task);
      if (!isContained(projectRoot, baseLexical)) {
        throw suiteFailure(
          "path-escape",
          suitePath,
          "$.include",
          `matrix base task escapes the project root: ${baseLexical}`,
          "Keep the matrix base task inside the project root."
        );
      }
      const basePath = await canonicalize(baseLexical);
      if (!isContained(projectRoot, basePath)) {
        throw suiteFailure(
          "path-escape",
          suitePath,
          "$.include",
          `matrix base task resolves outside the project root: ${basePath}`,
          "Remove the escaping symlink or use an in-project base task."
        );
      }
      const base = await resolveTaskInheritance(await readTask(basePath), {
        projectRoot,
        realpath: canonicalize,
        loadTask: readTask
      });
      resolvedTasks.push(...expandMatrix(matrix, base));
      continue;
    }

    throw suiteFailure(
      "include-kind",
      suitePath,
      "$.include",
      `suite include matched unsupported file kind: ${discoveredPath.path}`,
      "Select only *.task.yaml and *.matrix.yaml files."
    );
  }

  const selected = resolvedTasks.filter((task) =>
    taskMatchesTags(task.document, suite.document["tags"])
  );
  selected.sort((left, right) => {
    const pathOrder = codePointCompare(left.path, right.path);
    if (pathOrder !== 0) {
      return pathOrder;
    }
    return codePointCompare(String(left.document["id"]), String(right.document["id"]));
  });

  if (selected.length === 0) {
    throw suiteFailure(
      "empty",
      suitePath,
      "$.include",
      "suite resolves to no concrete tasks after tag filtering",
      "Select at least one concrete task and adjust tag filters if necessary."
    );
  }

  const ids = new Map<string, string>();
  for (const task of selected) {
    const taskId = String(task.document["id"]);
    const priorPath = ids.get(taskId);
    if (priorPath !== undefined) {
      const definingPaths = [priorPath, task.path].sort(codePointCompare);
      throw suiteFailure(
        "duplicate-id",
        suitePath,
        "$.include",
        `duplicate task id ${taskId} is defined by ${definingPaths.join(" and ")}`,
        "Give every resolved task and matrix instance a unique id.",
        { taskId, definingPaths }
      );
    }
    ids.set(taskId, task.path);
  }

  const tasks = selected.map((task): HashedResolvedTask => ({
    path: task.path,
    source: task.source,
    document: task.document,
    contentHash: taskContentHash(task.document)
  }));
  return {
    suite: { ...suite, path: suitePath },
    tasks,
    suiteContentHash: suiteContentHash(tasks.map((task) => task.contentHash)),
    warnings
  };
}
