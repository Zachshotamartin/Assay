import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import assayConfigSchema from "./schemas/assay-config.v1.schema.json" with { type: "json" };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false
});

ajv.addKeyword({ keyword: "x-assay-env", schemaType: "string", valid: true });
ajv.addKeyword({ keyword: "x-assay-env-mapping", schemaType: "object", valid: true });

const validator = ajv.compile(assayConfigSchema) as ValidateFunction<unknown>;

export interface ConfigSchemaSuccess {
  readonly ok: true;
}

export interface ConfigSchemaFailure {
  readonly ok: false;
  readonly errors: readonly ErrorObject[];
}

export type ConfigSchemaResult = ConfigSchemaSuccess | ConfigSchemaFailure;

export function validateConfigDocument(value: unknown): ConfigSchemaResult {
  if (validator(value)) return { ok: true };
  return { ok: false, errors: [...(validator.errors ?? [])] };
}
