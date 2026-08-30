import { AssayError } from "@assay/contracts";

export type RedactionOperation =
  | "text validation"
  | "pattern detection"
  | "entropy detection"
  | "UTF-8 decoding"
  | "JSON traversal"
  | "stream accumulation"
  | "stream finalization";

export class RedactionError extends AssayError {
  readonly operation: RedactionOperation;

  constructor(operation: RedactionOperation) {
    super("redaction_failed", `Redaction failed during ${operation}.`);
    this.name = "RedactionError";
    this.operation = operation;
  }
}

export function failRedaction(operation: RedactionOperation): never {
  throw new RedactionError(operation);
}

export function failClosed<T>(operation: RedactionOperation, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof RedactionError) {
      throw error;
    }
    // Detector errors may themselves contain captured data. Discard the cause
    // and expose only the stable category/message.
    throw new RedactionError(operation);
  }
}
