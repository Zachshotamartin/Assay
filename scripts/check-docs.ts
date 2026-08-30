import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

export const GATE_STATUSES = ["accepted", "in progress", "planned", "deferred"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];
export type GateId = `R${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;

export type DocumentationViolationCode =
  | "status-file-invalid"
  | "current-claim-missing"
  | "gate-status-drift"
  | "gate-status-missing"
  | "invalid-status"
  | "forbidden-install-command"
  | "forbidden-present-claim";

export interface DocumentationViolation {
  readonly code: DocumentationViolationCode;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly gate?: GateId;
}

interface StatusConfiguration {
  readonly currentClaim: string;
  readonly claimDocuments: readonly string[];
  readonly statusTableDocuments: readonly string[];
  readonly buildPlanDocument: string;
  readonly plannedInstallSections: Readonly<Record<string, readonly string[]>>;
  readonly gates: Readonly<Record<GateId, GateStatus>>;
}

const GATES = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"] as const;
const INSTALL_COMMAND =
  /\b(?:npm\s+(?:install|i)\s+(?:-g\s+)?assay(?:@[^\s`)]+)?|npx\s+assay|pnpm\s+add\s+assay|yarn\s+add\s+assay)\b/iu;
const PRESENT_CLAIMS = [
  /\bAssay works(?:\s+today)?\b/iu,
  /\bAssay is implemented\b/iu,
  /\bAssay is available today\b/iu,
  /\bAssay now supports\b/iu
] as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function parseStatusConfiguration(source: string): StatusConfiguration {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors[0]?.message ?? "invalid status YAML");
  }
  const root = asRecord(document.toJS() as unknown, "docs/status.yaml");
  const currentClaim = root["current_claim"];
  if (typeof currentClaim !== "string" || currentClaim.trim() === "") {
    throw new Error("current_claim must be a non-empty string");
  }
  const claimDocuments = stringArray(root["claim_documents"], "claim_documents");
  const statusTableDocuments =
    root["status_table_documents"] === undefined
      ? ["README.md"]
      : stringArray(root["status_table_documents"], "status_table_documents");
  const buildPlanDocument = root["build_plan_document"] ?? "docs/BUILD_PLAN.md";
  if (typeof buildPlanDocument !== "string") {
    throw new Error("build_plan_document must be a string");
  }

  const installSectionsValue = root["planned_install_sections"] ?? {};
  const installSectionsRecord = asRecord(installSectionsValue, "planned_install_sections");
  const plannedInstallSections: Record<string, readonly string[]> = {};
  for (const [file, sections] of Object.entries(installSectionsRecord)) {
    plannedInstallSections[file] = stringArray(sections, `planned_install_sections.${file}`);
  }

  const gateValues = asRecord(root["gates"], "gates");
  const gates = {} as Record<GateId, GateStatus>;
  for (const gate of GATES) {
    const status = gateValues[gate];
    if (typeof status !== "string" || !(GATE_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`${gate} must use one of: ${GATE_STATUSES.join(", ")}`);
    }
    gates[gate] = status as GateStatus;
  }
  const unknownGates = Object.keys(gateValues).filter(
    (gate) => !(GATES as readonly string[]).includes(gate)
  );
  if (unknownGates.length > 0) {
    throw new Error(`unknown gate in status file: ${unknownGates[0] as string}`);
  }

  return {
    currentClaim: currentClaim.replace(/\s+/gu, " ").trim(),
    claimDocuments,
    statusTableDocuments,
    buildPlanDocument,
    plannedInstallSections,
    gates
  };
}

function violation(
  code: DocumentationViolationCode,
  file: string,
  line: number,
  message: string,
  gate?: GateId
): DocumentationViolation {
  return gate === undefined ? { code, file, line, message } : { code, file, line, message, gate };
}

function normalizedBlockquotes(source: string): readonly { readonly text: string; readonly line: number }[] {
  const lines = source.split(/\r?\n/u);
  const groups: { text: string; line: number }[] = [];
  let parts: string[] = [];
  let start = 0;

  function finish(): void {
    if (parts.length > 0) {
      groups.push({ text: parts.join(" ").replace(/\s+/gu, " ").trim(), line: start });
      parts = [];
    }
  }

  lines.forEach((line, index) => {
    const match = /^\s*>\s?(.*)$/u.exec(line);
    if (match === null) {
      finish();
      return;
    }
    if (parts.length === 0) {
      start = index + 1;
    }
    parts.push(match[1] ?? "");
  });
  finish();
  return groups;
}

function checkCurrentClaim(
  file: string,
  source: string,
  expected: string
): DocumentationViolation | undefined {
  if (normalizedBlockquotes(source).some(({ text }) => text === expected)) {
    return undefined;
  }
  return violation(
    "current-claim-missing",
    file,
    1,
    "verbatim current-claim blockquote is missing"
  );
}

function tableStatuses(
  file: string,
  source: string
): { readonly found: ReadonlyMap<GateId, { readonly status: string; readonly line: number }>; readonly invalid?: DocumentationViolation } {
  const found = new Map<GateId, { status: string; line: number }>();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trimStart().startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const gate = cells[0];
    if (!(GATES as readonly string[]).includes(gate ?? "")) {
      continue;
    }
    const status = cells.at(-1) ?? "";
    if (!(GATE_STATUSES as readonly string[]).includes(status)) {
      return {
        found,
        invalid: violation(
          "invalid-status",
          file,
          index + 1,
          `${gate as string} uses unknown status ${JSON.stringify(status)}`,
          gate as GateId
        )
      };
    }
    found.set(gate as GateId, { status, line: index + 1 });
  }
  return { found };
}

function checkStatusTable(
  file: string,
  source: string,
  expected: Readonly<Record<GateId, GateStatus>>
): DocumentationViolation | undefined {
  const parsed = tableStatuses(file, source);
  if (parsed.invalid !== undefined) {
    return parsed.invalid;
  }
  for (const gate of GATES) {
    const actual = parsed.found.get(gate);
    if (actual === undefined) {
      return violation("gate-status-missing", file, 1, `${gate} status row is missing`, gate);
    }
    if (actual.status !== expected[gate]) {
      return violation(
        "gate-status-drift",
        file,
        actual.line,
        `${gate} is ${actual.status}; docs/status.yaml says ${expected[gate]}`,
        gate
      );
    }
  }
  return undefined;
}

function buildPlanStatuses(
  file: string,
  source: string,
  expected: Readonly<Record<GateId, GateStatus>>
): DocumentationViolation | undefined {
  const lines = source.split(/\r?\n/u);
  const found = new Map<GateId, { status: string; line: number }>();
  let current: GateId | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^##\s+\d+\.\s+(R(?:10|[0-9]))\b/u.exec(line);
    if (heading !== null) {
      current = heading[1] as GateId;
      continue;
    }
    const status = /^\*\*Status:\*\*\s+(.+?)\.?\s*$/u.exec(line);
    if (status === null || current === undefined) {
      continue;
    }
    const value = status[1] ?? "";
    if (!(GATE_STATUSES as readonly string[]).includes(value)) {
      return violation(
        "invalid-status",
        file,
        index + 1,
        `${current} uses unknown status ${JSON.stringify(value)}`,
        current
      );
    }
    found.set(current, { status: value, line: index + 1 });
    current = undefined;
  }

  for (const gate of GATES) {
    const actual = found.get(gate);
    if (actual === undefined) {
      return violation("gate-status-missing", file, 1, `${gate} status declaration is missing`, gate);
    }
    if (actual.status !== expected[gate]) {
      return violation(
        "gate-status-drift",
        file,
        actual.line,
        `${gate} is ${actual.status}; docs/status.yaml says ${expected[gate]}`,
        gate
      );
    }
  }
  return undefined;
}

async function markdownDocuments(rootDir: string): Promise<readonly string[]> {
  const files = ["README.md"];
  for (const entry of await readdir(resolve(rootDir, "docs"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(`docs/${entry.name}`);
    }
  }
  return files.sort();
}

function checkForbiddenClaims(
  file: string,
  source: string,
  configuration: StatusConfiguration
): DocumentationViolation | undefined {
  const releasePlanned = configuration.gates.R10 !== "accepted";
  let heading = "";
  const allowedSections = new Set(configuration.plannedInstallSections[file] ?? []);
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (headingMatch !== null) {
      heading = headingMatch[1] ?? "";
    }
    if (releasePlanned && INSTALL_COMMAND.test(line) && !allowedSections.has(heading)) {
      return violation(
        "forbidden-install-command",
        file,
        index + 1,
        `unqualified install command appears while R10 is ${configuration.gates.R10}`
      );
    }
    if (PRESENT_CLAIMS.some((pattern) => pattern.test(line))) {
      return violation(
        "forbidden-present-claim",
        file,
        index + 1,
        "unqualified present-tense product claim is not backed by accepted gate evidence"
      );
    }
  }
  return undefined;
}

export async function inspectDocumentation(rootDir: string): Promise<readonly DocumentationViolation[]> {
  const absoluteRoot = resolve(rootDir);
  let configuration: StatusConfiguration;
  try {
    configuration = parseStatusConfiguration(
      await readFile(resolve(absoluteRoot, "docs/status.yaml"), "utf8")
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown status-file error";
    return [violation("status-file-invalid", "docs/status.yaml", 1, message)];
  }

  for (const file of configuration.claimDocuments) {
    const issue = checkCurrentClaim(
      file,
      await readFile(resolve(absoluteRoot, file), "utf8"),
      configuration.currentClaim
    );
    if (issue !== undefined) {
      return [issue];
    }
  }

  for (const file of configuration.statusTableDocuments) {
    const issue = checkStatusTable(
      file,
      await readFile(resolve(absoluteRoot, file), "utf8"),
      configuration.gates
    );
    if (issue !== undefined) {
      return [issue];
    }
  }

  const buildPlanIssue = buildPlanStatuses(
    configuration.buildPlanDocument,
    await readFile(resolve(absoluteRoot, configuration.buildPlanDocument), "utf8"),
    configuration.gates
  );
  if (buildPlanIssue !== undefined) {
    return [buildPlanIssue];
  }

  for (const file of await markdownDocuments(absoluteRoot)) {
    const issue = checkForbiddenClaims(
      file,
      await readFile(resolve(absoluteRoot, file), "utf8"),
      configuration
    );
    if (issue !== undefined) {
      return [issue];
    }
  }

  return [];
}

export function formatDocumentationViolation(issue: DocumentationViolation): string {
  return `${issue.file}:${issue.line} docs[${issue.code}]: ${issue.message}`;
}

async function main(): Promise<void> {
  const issues = await inspectDocumentation(process.cwd());
  if (issues.length === 0) {
    process.stdout.write("documentation consistency: ok\n");
    return;
  }
  process.stderr.write(`${formatDocumentationViolation(issues[0] as DocumentationViolation)}\n`);
  process.exitCode = 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  await main();
}
