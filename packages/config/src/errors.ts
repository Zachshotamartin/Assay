import { AssayError } from "@assay/contracts";

export interface ConfigDiagnostic {
  readonly code: string;
  readonly source: string;
  readonly key: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

export class ConfigError extends AssayError implements ConfigDiagnostic {
  declare readonly category: "invalid_configuration";
  readonly code: string;
  readonly source: string;
  readonly key: string;
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(diagnostic: ConfigDiagnostic, detail: string) {
    const position = diagnostic.line === undefined
      ? ""
      : `:${diagnostic.line}:${diagnostic.column ?? 1}`;
    super(
      "invalid_configuration",
      `invalid_configuration: ${diagnostic.source}${position} key ${diagnostic.key} ${detail}`
    );
    this.name = "ConfigError";
    this.code = diagnostic.code;
    this.source = diagnostic.source;
    this.key = diagnostic.key;
    this.line = diagnostic.line;
    this.column = diagnostic.column;
  }
}

export function configError(
  code: string,
  source: string,
  key: string,
  detail: string,
  position: { readonly line?: number; readonly column?: number } = {}
): ConfigError {
  return new ConfigError(
    {
      code: `invalid_configuration/${code}`,
      source,
      key,
      line: position.line,
      column: position.column
    },
    detail
  );
}
