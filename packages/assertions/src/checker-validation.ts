import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { AssayError } from "@assay/contracts";
import ts from "typescript";

import type { CheckerAssertionSpec, ValidatedCheckerModule } from "./types.js";
import { validateWorkspacePath } from "./validation.js";

const CHECKER_API_MODULE = "@assay/checker-api";
const CHECKER_API_VIRTUAL_FILE = "/__assay_checker_api__.d.ts";
const CHECKER_API_DECLARATION = `
declare module "@assay/checker-api" {
  export interface TaskDefinition {
    readonly formatVersion: "1.0";
    readonly id: string;
    readonly title: string;
    readonly tags: readonly string[];
    readonly fixture: unknown;
    readonly prompt: string;
    readonly toolset: unknown;
    readonly sandbox: unknown;
    readonly assertions: readonly unknown[];
    readonly [key: string]: unknown;
  }
  export interface WorkspaceReader {
    exists(path: string): Promise<boolean>;
    readText(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    list(path?: string): Promise<readonly string[]>;
  }
  export interface TrajectoryReader {
    events(): readonly unknown[];
  }
  export interface CheckerContext {
    readonly task: TaskDefinition;
    readonly workspace: WorkspaceReader;
    readonly trajectory: TrajectoryReader;
    readonly log: (message: string) => void;
  }
  export interface CheckerVerdict {
    readonly verdict: "pass" | "fail";
    readonly observed: string;
    readonly expectation: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }
  export type CheckerFunction = (ctx: CheckerContext) => Promise<CheckerVerdict>;
}
`;

export class CheckerValidationError extends AssayError {
  readonly code: string;
  readonly filePath: string | undefined;

  constructor(code: string, message: string, filePath?: string, cause?: unknown) {
    super("checker_invalid", `checker_invalid: ${message}`, cause === undefined ? {} : { cause });
    this.name = "CheckerValidationError";
    this.code = `checker_invalid/${code}`;
    this.filePath = filePath;
  }
}

function invalid(code: string, message: string, filePath?: string, cause?: unknown): never {
  throw new CheckerValidationError(code, message, filePath, cause);
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function validateSpec(spec: CheckerAssertionSpec): void {
  if (typeof spec !== "object" || spec === null || spec.type !== "checker") {
    invalid("schema", "checker assertion must be a mapping with type checker");
  }
  const keys = Object.keys(spec as unknown as Readonly<Record<string, unknown>>);
  const allowed = new Set(["type", "name", "module", "timeout_ms", "memory_mb"]);
  const unknown = keys.filter((key) => !allowed.has(key)).sort()[0];
  if (unknown !== undefined) {
    invalid("schema", `unknown checker assertion field ${JSON.stringify(unknown)}`);
  }
  if (typeof spec.module !== "string" || !spec.module.endsWith(".checker.ts")) {
    invalid("schema", "checker module must be a relative *.checker.ts path");
  }
  try {
    validateWorkspacePath(spec.module, "checker module");
  } catch (error) {
    invalid("path-escape", "checker module path must remain inside the project root", spec.module, error);
  }
  if (spec.name !== undefined &&
      (typeof spec.name !== "string" || spec.name.length < 1 || spec.name.length > 64)) {
    invalid("schema", "checker name must contain 1 through 64 characters");
  }
  if (spec.timeout_ms !== undefined &&
      (!Number.isInteger(spec.timeout_ms) || spec.timeout_ms < 100 || spec.timeout_ms > 60_000)) {
    invalid("schema", "checker timeout_ms must be an integer from 100 through 60000");
  }
  if (spec.memory_mb !== undefined &&
      (!Number.isInteger(spec.memory_mb) || spec.memory_mb < 32 || spec.memory_mb > 1_024)) {
    invalid("schema", "checker memory_mb must be an integer from 32 through 1024");
  }
}

function typeOnlyApiImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name !== undefined || clause.namedBindings === undefined) {
    return false;
  }
  return ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function relativeCandidates(importer: string, specifier: string): readonly string[] {
  const resolved = resolve(dirname(importer), specifier);
  const extension = extname(resolved);
  if (extension === ".js") {
    return [resolved.slice(0, -3) + ".ts", resolved.slice(0, -3) + ".tsx", resolved];
  }
  if (extension === ".mjs") {
    return [resolved.slice(0, -4) + ".mts", resolved];
  }
  if (extension === ".cjs") {
    return [resolved.slice(0, -4) + ".cts", resolved];
  }
  if (extension === "") {
    return [
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}.mts`,
      `${resolved}.cts`,
      resolve(resolved, "index.ts")
    ];
  }
  return [resolved];
}

async function resolveRelativeModule(
  importer: string,
  specifier: string,
  checkerRoot: string
): Promise<string> {
  const lexical = resolve(dirname(importer), specifier);
  if (!contained(checkerRoot, lexical)) {
    return invalid(
      "import-path-escape",
      `relative import ${JSON.stringify(specifier)} leaves the checker directory subtree`,
      importer
    );
  }
  for (const candidate of relativeCandidates(importer, specifier)) {
    try {
      const canonical = await realpath(candidate);
      if (!contained(checkerRoot, canonical)) {
        return invalid(
          "import-path-escape",
          `relative import ${JSON.stringify(specifier)} resolves outside the checker directory subtree`,
          importer
        );
      }
      if (!new Set([".ts", ".tsx", ".mts", ".cts"]).has(extname(canonical))) {
        return invalid("import-restriction", "checker relative imports must resolve to TypeScript", importer);
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return invalid("module-unreadable", `cannot resolve ${JSON.stringify(specifier)}`, importer, error);
      }
    }
  }
  return invalid("module-unreadable", `cannot resolve relative import ${JSON.stringify(specifier)}`, importer);
}

function moduleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  return node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

async function importsFrom(
  sourceFile: ts.SourceFile,
  checkerRoot: string
): Promise<readonly string[]> {
  const relatives: string[] = [];
  const work: Promise<void>[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node);
      if (specifier === undefined) {
        invalid("import-restriction", "checker import specifier must be a string literal", sourceFile.fileName);
      }
      if (specifier === CHECKER_API_MODULE) {
        if (!typeOnlyApiImport(node)) {
          invalid("import-restriction", "@assay/checker-api may be imported only with import type", sourceFile.fileName);
        }
      } else if (specifier.startsWith(".")) {
        work.push(resolveRelativeModule(sourceFile.fileName, specifier, checkerRoot).then((path) => {
          relatives.push(path);
        }));
      } else {
        invalid("import-restriction", `checker import ${JSON.stringify(specifier)} is forbidden`, sourceFile.fileName);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = moduleSpecifier(node);
      if (specifier === undefined) {
        invalid("import-restriction", "checker export specifier must be a string literal", sourceFile.fileName);
      }
      if (specifier === CHECKER_API_MODULE) {
        if (!node.isTypeOnly) {
          invalid("import-restriction", "@assay/checker-api may be exported only as types", sourceFile.fileName);
        }
      } else if (specifier.startsWith(".")) {
        work.push(resolveRelativeModule(sourceFile.fileName, specifier, checkerRoot).then((path) => {
          relatives.push(path);
        }));
      } else {
        invalid("import-restriction", `checker export ${JSON.stringify(specifier)} is forbidden`, sourceFile.fileName);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      invalid("import-restriction", "import-equals declarations are forbidden in checkers", sourceFile.fileName);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        invalid("import-restriction", "dynamic import and require are forbidden in checkers", sourceFile.fileName);
      }
    }
    ts.forEachChild(node, visit);
  };

  if (
    sourceFile.referencedFiles.length > 0 ||
    sourceFile.typeReferenceDirectives.length > 0 ||
    sourceFile.libReferenceDirectives.length > 0
  ) {
    invalid("import-restriction", "triple-slash references are forbidden in checkers", sourceFile.fileName);
  }
  visit(sourceFile);
  await Promise.all(work);
  return relatives.sort();
}

async function collectSources(modulePath: string, checkerRoot: string): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  const queue = [modulePath];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (sources.has(path)) {
      continue;
    }
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      return invalid("module-unreadable", `cannot read checker source ${path}`, path, error);
    }
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    sources.set(path, source);
    for (const imported of await importsFrom(sourceFile, checkerRoot)) {
      if (!sources.has(imported)) {
        queue.push(imported);
      }
    }
    queue.sort();
  }
  return sources;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return message;
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1}: ${message}`;
}

function typeCheck(modulePath: string, sources: ReadonlyMap<string, string>): void {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    lib: ["lib.es2023.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: false,
    types: []
  };
  const delegate = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...delegate,
    fileExists: (path) => path === CHECKER_API_VIRTUAL_FILE || sources.has(path) || delegate.fileExists(path),
    readFile: (path) => path === CHECKER_API_VIRTUAL_FILE
      ? CHECKER_API_DECLARATION
      : sources.get(path) ?? delegate.readFile(path),
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = path === CHECKER_API_VIRTUAL_FILE
        ? CHECKER_API_DECLARATION
        : sources.get(path);
      return source === undefined
        ? delegate.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS);
    }
  };
  const program = ts.createProgram({
    rootNames: [...sources.keys(), CHECKER_API_VIRTUAL_FILE],
    options,
    host
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    invalid(
      "typecheck",
      `checker failed TypeScript validation: ${diagnostics.slice(0, 5).map(diagnosticMessage).join(" | ")}`,
      modulePath
    );
  }

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(modulePath);
  const sourceSymbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
  const checkSymbol = sourceSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(sourceSymbol).find((symbol) => symbol.name === "check");
  if (checkSymbol === undefined || sourceFile === undefined) {
    invalid("export", "checker must export check", modulePath);
  }
  const ambientModule = checker.getAmbientModules().find(
    (symbol) => symbol.name === JSON.stringify(CHECKER_API_MODULE)
  );
  const functionSymbol = ambientModule === undefined
    ? undefined
    : checker.getExportsOfModule(ambientModule).find((symbol) => symbol.name === "CheckerFunction");
  if (functionSymbol === undefined) {
    throw new Error("internal checker API declaration did not compile");
  }
  const checkType = checker.getTypeOfSymbolAtLocation(checkSymbol, sourceFile);
  const expectedType = checker.getDeclaredTypeOfSymbol(functionSymbol);
  if (!checker.isTypeAssignableTo(checkType, expectedType)) {
    invalid(
      "signature",
      "exported check must have signature (ctx: CheckerContext) => Promise<CheckerVerdict>",
      modulePath
    );
  }
}

export async function validateCheckerModule(
  spec: CheckerAssertionSpec,
  projectRoot: string
): Promise<ValidatedCheckerModule> {
  validateSpec(spec);
  const canonicalProject = await realpath(resolve(projectRoot)).catch((error: unknown) =>
    invalid("path", "project root cannot be resolved", projectRoot, error));
  const lexicalModule = resolve(canonicalProject, spec.module);
  if (!contained(canonicalProject, lexicalModule)) {
    invalid("path-escape", "checker module path leaves the project root", lexicalModule);
  }
  const modulePath = await realpath(lexicalModule).catch((error: unknown) =>
    invalid("module-unreadable", `checker module cannot be resolved: ${spec.module}`, lexicalModule, error));
  if (!contained(canonicalProject, modulePath)) {
    invalid("path-escape", "checker module resolves outside the project root", modulePath);
  }
  const checkerRoot = dirname(modulePath);
  const sources = await collectSources(modulePath, checkerRoot);
  typeCheck(modulePath, sources);
  return {
    modulePath,
    checkerRoot,
    sourceFiles: [...sources.keys()].sort()
  };
}
