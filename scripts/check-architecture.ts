import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type ArchitectureViolationCode =
  | "disallowed-package-edge"
  | "package-imports-app"
  | "imports-app"
  | "workspace-deep-import"
  | "undeclared-workspace-dependency"
  | "checker-worker-import"
  | "nondeterministic-source";

export interface ArchitectureViolation {
  readonly code: ArchitectureViolationCode;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importer: string;
  readonly imported: string;
  readonly specifier: string;
}

interface ArchitectureConfig {
  readonly workspaces: Readonly<Record<string, readonly string[]>>;
}

interface Workspace {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: "app" | "package";
  readonly name: string;
  readonly allowed: ReadonlySet<string>;
  readonly declaredDependencies: ReadonlySet<string>;
  readonly publicExports: ReadonlySet<string>;
}

interface ImportSite {
  readonly specifier: string;
  readonly position: number;
}

type NondeterministicSource = "Date.now" | "Math.random" | "crypto.randomUUID" | "setTimeout";

const SOURCE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts"] as const;
const NONDETERMINISTIC_SOURCE_ALLOWLIST: Readonly<Record<NondeterministicSource, ReadonlySet<string>>> = {
  "Date.now": new Set(["apps/cli/src/runtime.ts"]),
  "Math.random": new Set(),
  "crypto.randomUUID": new Set(),
  setTimeout: new Set([
    "packages/adapter-core/src/supervisor.ts",
    "packages/adapter-simulated/src/scenario.ts",
    "packages/assertions/src/command-runner.ts",
    "packages/run-store/src/lock.ts",
    "packages/run-store/src/store.ts"
  ])
};

function slash(value: string): string {
  return value.split(sep).join("/");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseConfig(value: unknown): ArchitectureConfig {
  const root = asRecord(value, "architecture config");
  const workspaces = asRecord(root["workspaces"], "architecture config workspaces");
  const parsed: Record<string, readonly string[]> = {};

  for (const [workspace, dependencies] of Object.entries(workspaces)) {
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== "string")
    ) {
      throw new Error(`architecture config entry ${workspace} must be an array of workspace paths`);
    }
    parsed[workspace] = dependencies as string[];
  }

  return { workspaces: parsed };
}

function packageDependencies(packageJson: Record<string, unknown>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const section = packageJson[key];
    if (typeof section === "object" && section !== null && !Array.isArray(section)) {
      for (const name of Object.keys(section)) {
        names.add(name);
      }
    }
  }
  return names;
}

function packageExports(packageJson: Record<string, unknown>): ReadonlySet<string> {
  const exportsValue = packageJson["exports"];
  if (typeof exportsValue !== "object" || exportsValue === null || Array.isArray(exportsValue)) {
    return new Set(["."]);
  }
  const keys = Object.keys(exportsValue);
  return new Set(keys.some((key) => key.startsWith(".")) ? keys : ["."]);
}

async function loadWorkspaces(rootDir: string, config: ArchitectureConfig): Promise<readonly Workspace[]> {
  const workspaces: Workspace[] = [];
  for (const [workspacePath, allowed] of Object.entries(config.workspaces)) {
    if (!workspacePath.startsWith("apps/") && !workspacePath.startsWith("packages/")) {
      throw new Error(`workspace path must start with apps/ or packages/: ${workspacePath}`);
    }
    const packageJson = asRecord(
      await readJson(resolve(rootDir, workspacePath, "package.json")),
      `${workspacePath}/package.json`
    );
    const name = packageJson["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`${workspacePath}/package.json must contain a package name`);
    }

    workspaces.push({
      path: workspacePath,
      absolutePath: resolve(rootDir, workspacePath),
      kind: workspacePath.startsWith("apps/") ? "app" : "package",
      name,
      allowed: new Set(allowed),
      declaredDependencies: packageDependencies(packageJson),
      publicExports: packageExports(packageJson)
    });
  }
  return workspaces;
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        found.push(absolute);
      }
    }
  }
  await visit(directory);
  return found.sort();
}

function importSites(sourceFile: ts.SourceFile): readonly ImportSite[] {
  const sites: ImportSite[] = [];
  function add(node: ts.Expression | undefined): void {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      sites.push({ specifier: node.text, position: node.getStart(sourceFile) });
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

function expressionPath(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent === undefined ? expression.name.text : `${parent}.${expression.name.text}`;
  }
  return undefined;
}

function canonicalNondeterministicSource(path: string): NondeterministicSource | undefined {
  if (path === "Date.now" || path.endsWith(".Date.now")) return "Date.now";
  if (path === "Math.random" || path.endsWith(".Math.random")) return "Math.random";
  if (path === "randomUUID" || path.endsWith(".randomUUID")) return "crypto.randomUUID";
  if (path === "setTimeout" || path.endsWith(".setTimeout")) return "setTimeout";
  return undefined;
}

function nondeterministicSites(sourceFile: ts.SourceFile): readonly ImportSite[] {
  const sites: ImportSite[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const path = expressionPath(node.expression);
      const source = path === undefined ? undefined : canonicalNondeterministicSource(path);
      if (source !== undefined) {
        sites.push({ specifier: source, position: node.expression.getStart(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

function isTestSource(repositoryPath: string): boolean {
  return /(?:^|\/)[^/]+\.(?:e2e\.|property\.)?test\.[cm]?[jt]sx?$/u.test(repositoryPath);
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function workspaceForSpecifier(
  specifier: string,
  sourcePath: string,
  workspaces: readonly Workspace[]
): { readonly workspace: Workspace; readonly deep: boolean } | undefined {
  const named = workspaces
    .filter(({ name }) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (named !== undefined) {
    const subpath = specifier === named.name ? "." : `.${specifier.slice(named.name.length)}`;
    return { workspace: named, deep: !named.publicExports.has(subpath) };
  }

  if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
    return undefined;
  }
  const target = resolve(dirname(sourcePath), specifier);
  const workspace = workspaces.find(({ absolutePath }) => containsPath(absolutePath, target));
  if (workspace === undefined) {
    return undefined;
  }
  return { workspace, deep: true };
}

function classify(
  importer: Workspace,
  imported: Workspace,
  deep: boolean,
  specifier: string
): ArchitectureViolationCode | undefined {
  if (importer.path === imported.path) {
    return undefined;
  }
  if (imported.kind === "app") {
    return importer.kind === "package" ? "package-imports-app" : "imports-app";
  }
  if (!importer.allowed.has(imported.path)) {
    return "disallowed-package-edge";
  }
  if (deep) {
    return "workspace-deep-import";
  }
  if (!importer.declaredDependencies.has(imported.name)) {
    return "undeclared-workspace-dependency";
  }
  void specifier;
  return undefined;
}

export async function inspectArchitecture(rootDir: string): Promise<readonly ArchitectureViolation[]> {
  const absoluteRoot = resolve(rootDir);
  const config = parseConfig(await readJson(resolve(absoluteRoot, "architecture.config.json")));
  const workspaces = await loadWorkspaces(absoluteRoot, config);
  const violations: ArchitectureViolation[] = [];

  for (const importer of workspaces) {
    for (const file of await sourceFiles(importer.absolutePath)) {
      const source = await readFile(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const repositoryPath = slash(relative(absoluteRoot, file));
      if (!isTestSource(repositoryPath)) {
        for (const site of nondeterministicSites(sourceFile)) {
          const primitive = site.specifier as NondeterministicSource;
          if (NONDETERMINISTIC_SOURCE_ALLOWLIST[primitive].has(repositoryPath)) {
            continue;
          }
          const location = sourceFile.getLineAndCharacterOfPosition(site.position);
          violations.push({
            code: "nondeterministic-source",
            file: repositoryPath,
            line: location.line + 1,
            column: location.character + 1,
            importer: importer.path,
            imported: "injected clocks, IDs, randomness, or schedulers",
            specifier: primitive
          });
        }
      }
      for (const site of importSites(sourceFile)) {
        if (
          repositoryPath === "packages/assertions/src/checker-worker-entry.ts" &&
          site.specifier !== "node:worker_threads"
        ) {
          const location = sourceFile.getLineAndCharacterOfPosition(site.position);
          violations.push({
            code: "checker-worker-import",
            file: repositoryPath,
            line: location.line + 1,
            column: location.character + 1,
            importer: importer.path,
            imported: "checker-worker-entry-allowlist",
            specifier: site.specifier
          });
          continue;
        }
        const target = workspaceForSpecifier(site.specifier, file, workspaces);
        if (target === undefined) {
          continue;
        }
        const code = classify(importer, target.workspace, target.deep, site.specifier);
        if (code === undefined) {
          continue;
        }
        const location = sourceFile.getLineAndCharacterOfPosition(site.position);
        violations.push({
          code,
          file: repositoryPath,
          line: location.line + 1,
          column: location.character + 1,
          importer: importer.path,
          imported: target.workspace.path,
          specifier: site.specifier
        });
      }
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.specifier.localeCompare(right.specifier)
  );
}

export function formatArchitectureViolation(violation: ArchitectureViolation): string {
  if (violation.code === "nondeterministic-source") {
    return `${violation.file}:${violation.line}:${violation.column} architecture[${violation.code}]: ${violation.specifier} is allowed only in its composition-root or platform implementation`;
  }
  return `${violation.file}:${violation.line}:${violation.column} architecture[${violation.code}]: ${violation.importer} may not import ${violation.imported} via ${JSON.stringify(violation.specifier)}`;
}

async function main(): Promise<void> {
  const violations = await inspectArchitecture(process.cwd());
  if (violations.length === 0) {
    process.stdout.write("architecture boundaries: ok\n");
    return;
  }
  process.stderr.write(`${formatArchitectureViolation(violations[0] as ArchitectureViolation)}\n`);
  process.exitCode = 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  await main();
}
