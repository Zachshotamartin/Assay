import { AssayError } from "@assay/contracts";

export type AssertionLayer = "deterministic" | "checker" | "judge";

const DETERMINISTIC_TYPES = new Set([
  "exit_code",
  "tests_pass",
  "file_exists",
  "file_absent",
  "file_contains",
  "json_schema",
  "diff_matches",
  "command_output",
  "trajectory"
]);

export class AssertionLayerOrderError extends AssayError {
  readonly code = "task_invalid/assertion-layer-order" as const;
  readonly assertionIndex: number;

  constructor(assertionIndex: number, type: string) {
    super(
      "task_invalid",
      `task_invalid: assertion at index ${assertionIndex} (${type}) is out of deterministic -> checker -> judge order`
    );
    this.name = "AssertionLayerOrderError";
    this.assertionIndex = assertionIndex;
  }
}

function layerFor(value: unknown, index: number): AssertionLayer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AssayError("task_invalid", `task_invalid: assertion at index ${index} must be a mapping`);
  }
  const type = (value as Readonly<Record<string, unknown>>)["type"];
  if (type === "checker") {
    return "checker";
  }
  if (type === "judge") {
    return "judge";
  }
  if (typeof type === "string" && DETERMINISTIC_TYPES.has(type)) {
    return "deterministic";
  }
  throw new AssayError(
    "task_invalid",
    `task_invalid: assertion at index ${index} has unknown type ${JSON.stringify(type)}`
  );
}

export function validateAssertionLayerOrder(assertions: readonly unknown[]): readonly AssertionLayer[] {
  const rank: Readonly<Record<AssertionLayer, number>> = {
    deterministic: 0,
    checker: 1,
    judge: 2
  };
  const layers: AssertionLayer[] = [];
  let highest = 0;
  for (const [index, assertion] of assertions.entries()) {
    const layer = layerFor(assertion, index);
    if (rank[layer] < highest) {
      const type = (assertion as Readonly<Record<string, unknown>>)["type"] as string;
      throw new AssertionLayerOrderError(index, type);
    }
    highest = rank[layer];
    layers.push(layer);
  }
  return layers;
}
