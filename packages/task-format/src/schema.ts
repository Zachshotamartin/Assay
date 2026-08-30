import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import matrixSchema from "./schemas/matrix.v1.schema.json" with { type: "json" };
import suiteSchema from "./schemas/suite.v1.schema.json" with { type: "json" };
import taskSchema from "./schemas/task.v1.schema.json" with { type: "json" };

export const SUPPORTED_FORMAT_VERSION = "1.0" as const;

export interface SchemaValidationSuccess {
  readonly ok: true;
}

export interface SchemaValidationFailure {
  readonly ok: false;
  readonly code: string;
  readonly errors: readonly ErrorObject[];
}

export type SchemaValidationResult =
  | SchemaValidationSuccess
  | SchemaValidationFailure;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  validateFormats: false
});

const taskValidator = ajv.compile(taskSchema) as ValidateFunction<unknown>;
const suiteValidator = ajv.compile(suiteSchema) as ValidateFunction<unknown>;
const matrixValidator = ajv.compile(matrixSchema) as ValidateFunction<unknown>;

function declaredVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Readonly<Record<string, unknown>>)["format_version"];
  return typeof candidate === "string" ? candidate : undefined;
}

function validate(
  value: unknown,
  validator: ValidateFunction<unknown>,
  category: "task_invalid" | "suite_invalid"
): SchemaValidationResult {
  const version = declaredVersion(value);
  if (/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version ?? "") &&
      version !== SUPPORTED_FORMAT_VERSION) {
    return {
      ok: false,
      code: `${category}/format-version-unsupported`,
      errors: []
    };
  }

  if (validator(value)) {
    return { ok: true };
  }

  return {
    ok: false,
    code: `${category}/schema`,
    errors: [...(validator.errors ?? [])]
  };
}

export function validateTaskDocument(value: unknown): SchemaValidationResult {
  return validate(value, taskValidator, "task_invalid");
}

export function validateSuiteDocument(value: unknown): SchemaValidationResult {
  return validate(value, suiteValidator, "suite_invalid");
}

export function validateMatrixDocument(value: unknown): SchemaValidationResult {
  return validate(value, matrixValidator, "task_invalid");
}
