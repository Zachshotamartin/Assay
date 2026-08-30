import { dirname, resolve } from "node:path";

import {
  TaskFormatError,
  type LoadedYaml,
  type MatrixDocument,
  type MatrixScalar,
  type TaskDocument
} from "./load-yaml.js";
import { validateTaskDocument } from "./schema.js";

export const MAX_MATRIX_AXES = 4;
export const MAX_MATRIX_INSTANCES = 64;

export interface ExpandedMatrixTask extends LoadedYaml<TaskDocument> {
  readonly baseTaskPath: string;
  readonly matrixPath: string;
  readonly matrixValues: Readonly<Record<string, MatrixScalar>>;
}

class MatrixError extends TaskFormatError {
  readonly combinations: readonly Readonly<Record<string, MatrixScalar>>[] | undefined;

  constructor(
    code: string,
    matrixPath: string,
    yamlPath: string,
    message: string,
    remedy: string,
    combinations?: readonly Readonly<Record<string, MatrixScalar>>[]
  ) {
    super(
      {
        category: "task_invalid",
        code,
        filePath: matrixPath,
        yamlPath,
        line: undefined,
        column: undefined,
        remedy
      },
      message
    );
    this.name = "MatrixError";
    this.combinations = combinations;
  }
}

function matrixFailure(
  codeSuffix: string,
  matrixPath: string,
  yamlPath: string,
  detail: string,
  remedy: string,
  combinations?: readonly Readonly<Record<string, MatrixScalar>>[]
): MatrixError {
  return new MatrixError(
    `task_invalid/${codeSuffix}`,
    matrixPath,
    yamlPath,
    `task_invalid: ${detail}`,
    remedy,
    combinations
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scalarText(value: MatrixScalar): string {
  return String(value);
}

function scalarEqual(left: MatrixScalar, right: MatrixScalar): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function combinationsFor(
  axes: readonly (readonly [string, readonly MatrixScalar[]])[]
): readonly Readonly<Record<string, MatrixScalar>>[] {
  let combinations: readonly Readonly<Record<string, MatrixScalar>>[] = [{}];
  for (const [axis, values] of axes) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [axis]: value }))
    );
  }
  return combinations;
}

function validateExclusions(
  exclusions: readonly Readonly<Record<string, MatrixScalar>>[],
  axes: Readonly<Record<string, readonly MatrixScalar[]>>,
  matrixPath: string
): void {
  for (const [index, exclusion] of exclusions.entries()) {
    for (const [axis, value] of Object.entries(exclusion)) {
      const declaredValues = axes[axis];
      if (declaredValues === undefined ||
          !declaredValues.some((declared) => scalarEqual(declared, value))) {
        throw matrixFailure(
          "matrix-exclude",
          matrixPath,
          `$.exclude[${index}].${axis}`,
          `matrix exclusion names an unknown axis or value: ${axis}=${scalarText(value)}`,
          "Use only an axis value declared in this matrix."
        );
      }
    }
  }
}

function excluded(
  combination: Readonly<Record<string, MatrixScalar>>,
  exclusions: readonly Readonly<Record<string, MatrixScalar>>[]
): boolean {
  return exclusions.some((selector) =>
    Object.entries(selector).every(([axis, value]) => {
      const selected = combination[axis];
      return selected !== undefined && scalarEqual(selected, value);
    })
  );
}

const PLACEHOLDER = /\$\{\{\s*matrix\.([a-z0-9][a-z0-9-]{0,62})\s*\}\}/gu;

function substitute(
  value: unknown,
  combination: Readonly<Record<string, MatrixScalar>>,
  matrixPath: string,
  yamlPath: string
): unknown {
  if (typeof value === "string") {
    const replaced = value.replace(PLACEHOLDER, (_placeholder, axis: string) => {
      const replacement = combination[axis];
      if (replacement === undefined) {
        throw matrixFailure(
          "matrix-placeholder",
          matrixPath,
          yamlPath,
          `matrix placeholder names unknown axis ${axis}`,
          "Declare the axis or correct the placeholder name."
        );
      }
      return scalarText(replacement);
    });
    if (/\$\{\{\s*matrix\./u.test(replaced)) {
      throw matrixFailure(
        "matrix-placeholder",
        matrixPath,
        yamlPath,
        "matrix placeholder remained unresolved after substitution",
        "Use the exact ${{ matrix.<axis> }} form and declare that axis."
      );
    }
    return replaced;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => substitute(entry, combination, matrixPath, `${yamlPath}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = substitute(nested, combination, matrixPath, `${yamlPath}.${key}`);
    }
    return result;
  }
  return value;
}

function instanceId(
  baseId: string,
  combination: Readonly<Record<string, MatrixScalar>>
): string {
  const bindings = Object.keys(combination)
    .sort(codePointCompare)
    .map((axis) => `${axis}=${scalarText(combination[axis]!)}`)
    .join(",");
  return `${baseId}[${bindings}]`;
}

function validateConcreteInstance(
  document: TaskDocument,
  baseId: string,
  matrixPath: string,
  combination: Readonly<Record<string, MatrixScalar>>
): void {
  const validationDocument = { ...document, id: baseId };
  const validation = validateTaskDocument(validationDocument);
  if (!validation.ok) {
    throw matrixFailure(
      "matrix-instance",
      matrixPath,
      "$.axes",
      `expanded matrix combination is not a valid concrete task: ${JSON.stringify(combination)}`,
      "Make every substituted combination satisfy the concrete task schema.",
      [combination]
    );
  }
}

export function expandMatrix(
  matrix: LoadedYaml<MatrixDocument>,
  baseTask: LoadedYaml<TaskDocument>
): readonly ExpandedMatrixTask[] {
  const expectedBasePath = resolve(dirname(resolve(matrix.path)), matrix.document.task);
  if (expectedBasePath !== resolve(baseTask.path)) {
    throw matrixFailure(
      "matrix-task-mismatch",
      matrix.path,
      "$.task",
      `matrix task resolves to ${expectedBasePath}, not ${resolve(baseTask.path)}`,
      "Load and pass the base task named by the matrix task field."
    );
  }

  if (baseTask.document["extends"] !== undefined) {
    throw matrixFailure(
      "matrix-base-unresolved",
      matrix.path,
      "$.task",
      "matrix base task still contains extends",
      "Resolve task inheritance before expanding the matrix."
    );
  }

  const axes = Object.entries(matrix.document.axes);
  if (axes.length === 0 || axes.length > MAX_MATRIX_AXES) {
    throw matrixFailure(
      "matrix-size",
      matrix.path,
      "$.axes",
      `matrix must declare between 1 and ${MAX_MATRIX_AXES} axes`,
      `Declare at most ${MAX_MATRIX_AXES} non-empty axes.`
    );
  }
  const productSize = axes.reduce((size, [, values]) => size * values.length, 1);
  if (productSize > MAX_MATRIX_INSTANCES) {
    throw matrixFailure(
      "matrix-size",
      matrix.path,
      "$.axes",
      `matrix cross product has ${productSize} instances; maximum is ${MAX_MATRIX_INSTANCES}`,
      `Reduce the full pre-exclusion cross product to at most ${MAX_MATRIX_INSTANCES}.`
    );
  }

  const exclusions = matrix.document.exclude ?? [];
  validateExclusions(exclusions, matrix.document.axes, matrix.path);
  const combinations = combinationsFor(axes).filter((combination) =>
    !excluded(combination, exclusions)
  );
  if (combinations.length === 0) {
    throw matrixFailure(
      "matrix-empty",
      matrix.path,
      "$.exclude",
      "matrix exclusions remove every instance",
      "Remove or narrow an exclusion so at least one instance remains."
    );
  }

  const baseId = baseTask.document["id"];
  if (typeof baseId !== "string") {
    throw matrixFailure(
      "matrix-instance",
      matrix.path,
      "$.task",
      "matrix base task has no valid id",
      "Give the base task a valid task id."
    );
  }

  const seen = new Map<string, Readonly<Record<string, MatrixScalar>>>();
  return combinations.map((combination) => {
    const id = instanceId(baseId, combination);
    if (Array.from(id).length > 128) {
      throw matrixFailure(
        "matrix-id-length",
        matrix.path,
        "$.axes",
        `generated matrix id exceeds 128 characters: ${id}`,
        "Shorten the base task id, axis names, or axis values.",
        [combination]
      );
    }
    const prior = seen.get(id);
    if (prior !== undefined) {
      throw matrixFailure(
        "matrix-id-collision",
        matrix.path,
        "$.axes",
        `matrix combinations collide on generated id ${id}`,
        "Use axis values with distinct string representations.",
        [prior, combination]
      );
    }
    seen.set(id, combination);

    const substituted = substitute(baseTask.document, combination, matrix.path, "$.") as Record<string, unknown>;
    delete substituted["abstract"];
    substituted["id"] = id;
    validateConcreteInstance(substituted, baseId, matrix.path, combination);
    return {
      path: resolve(baseTask.path),
      source: baseTask.source,
      document: substituted,
      baseTaskPath: resolve(baseTask.path),
      matrixPath: resolve(matrix.path),
      matrixValues: { ...combination }
    };
  });
}
