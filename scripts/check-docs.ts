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
  | "forbidden-present-claim"
  | "r1-quickstart-command-missing"
  | "r1-boundary-statement-missing"
  | "r1-status-claim-invalid";

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
const R1_IN_PROGRESS_CLAIM =
  "Assay is under implementation. Gate R0 is accepted with repository, toolchain, CI, and GitHub governance evidence. Gate R1 has code and local evidence in progress; gates R2 through R10 remain planned. No evaluation product gate is accepted.";
const R1_QUICKSTART_HEADING = "Source-checkout R1 Preview (Unaccepted)";
const R1_QUICKSTART_COMMANDS = [
  "npm ci --ignore-scripts",
  "npm run build",
  "node apps/cli/dist/bin.js validate fixtures/suites/reference",
  "node apps/cli/dist/bin.js run fixtures/suites/reference.suite.yaml --variant baseline --adapter simulated -n 10 --seed 42"
] as const;
const R1_BOUNDARY_STATEMENTS = [
  {
    name: "source-only",
    text: "source-only preview evidence, not a published install or an acceptance claim"
  },
  {
    name: "no-isolation",
    text: "R1 has no sandbox or isolation boundary."
  },
  {
    name: "unsafe-host",
    text: "Every R1 execution is durable `unsafe_host` evidence and prints the unsafe-host warning"
  },
  {
    name: "no-real-agent-provider",
    text: "No real agent or provider is supported"
  }
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

interface MarkdownSection {
  readonly source: string;
  readonly line: number;
}

function levelTwoSection(source: string, heading: string): MarkdownSection | undefined {
  const lines = source.split(/\r?\n/u);
  const headingText = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === headingText);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test((lines[index] ?? "").trimStart())) {
      end = index;
      break;
    }
  }
  return {
    source: lines.slice(start + 1, end).join("\n"),
    line: start + 1
  };
}

function hasExactR1ShellBlock(source: string): boolean {
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() !== "```sh") continue;
    const closingOffset = lines.slice(index + 1).findIndex((line) => line.trim() === "```");
    if (closingOffset < 0) return false;
    const closing = index + 1 + closingOffset;
    if (lines.slice(index + 1, closing).join("\n") === R1_QUICKSTART_COMMANDS.join("\n")) {
      return true;
    }
    index = closing;
  }
  return false;
}

function checkR1InProgressClaim(
  configuration: StatusConfiguration
): DocumentationViolation | undefined {
  if (
    configuration.gates.R1 === "in progress" &&
    configuration.currentClaim !== R1_IN_PROGRESS_CLAIM
  ) {
    return violation(
      "r1-status-claim-invalid",
      "docs/status.yaml",
      1,
      "R1 in-progress status must retain the exact synchronized unaccepted-gate claim"
    );
  }
  return undefined;
}

function checkR1Quickstart(
  source: string,
  configuration: StatusConfiguration
): DocumentationViolation | undefined {
  if (configuration.gates.R1 !== "in progress") return undefined;
  const section = levelTwoSection(source, R1_QUICKSTART_HEADING);
  if (section === undefined || !hasExactR1ShellBlock(section.source)) {
    return violation(
      "r1-quickstart-command-missing",
      "README.md",
      section?.line ?? 1,
      "R1 in-progress documentation must retain the exact source-checkout build, validate, and deterministic simulated-run command block"
    );
  }
  const normalized = section.source.replace(/\s+/gu, " ").trim();
  for (const boundary of R1_BOUNDARY_STATEMENTS) {
    if (!normalized.includes(boundary.text)) {
      return violation(
        "r1-boundary-statement-missing",
        "README.md",
        section.line,
        `R1 quickstart is missing the required ${boundary.name} boundary statement`
      );
    }
  }
  return undefined;
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

  const r1ClaimIssue = checkR1InProgressClaim(configuration);
  if (r1ClaimIssue !== undefined) {
    return [r1ClaimIssue];
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

  const r1QuickstartIssue = checkR1Quickstart(
    await readFile(resolve(absoluteRoot, "README.md"), "utf8"),
    configuration
  );
  if (r1QuickstartIssue !== undefined) {
    return [r1QuickstartIssue];
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
