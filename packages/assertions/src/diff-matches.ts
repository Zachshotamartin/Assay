import { createHash } from "node:crypto";

import { AssertionSpecError, validateWorkspacePath } from "./validation.js";
import { readWorkspaceFile, readWorkspaceTree, type WorkspaceTreeEntry } from "./workspace.js";
import type { DiffMatchesAssertionSpec } from "./types.js";

const MAX_PATCH_BYTES = 10_485_760;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

type WhitespaceMode = "none" | "trailing" | "all";
type LineOperation =
  | { readonly kind: "equal"; readonly line: string }
  | { readonly kind: "removed"; readonly line: string }
  | { readonly kind: "added"; readonly line: string };

interface TextChange {
  readonly kind: "text";
  readonly removed: ReadonlyMap<string, number>;
  readonly added: ReadonlyMap<string, number>;
}

interface BinaryChange {
  readonly kind: "binary";
  readonly finalSha256: string;
}

type FileChange = TextChange | BinaryChange;

interface MutableTextChange {
  readonly kind: "text";
  readonly removed: Map<string, number>;
  readonly added: Map<string, number>;
}

interface ExpectedFileState {
  readonly path: string;
  readonly text: MutableTextChange;
  binarySha256: string | undefined;
  sawHunk: boolean;
  sawBinaryMarker: boolean;
}

function invalidPatch(message: string): never {
  throw new AssertionSpecError("diff-patch", `task_invalid: ${message}`);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeLine(line: string, mode: WhitespaceMode): string {
  if (mode === "trailing") {
    return line.replace(/\s+$/u, "");
  }
  if (mode === "all") {
    return line.replace(/\s+/gu, " ").trim();
  }
  return line;
}

function addCount(target: Map<string, number>, line: string): void {
  target.set(line, (target.get(line) ?? 0) + 1);
}

function lines(text: string): readonly string[] {
  const split = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (text.endsWith("\n")) {
    split.pop();
  }
  return split;
}

function decodeText(entry: WorkspaceTreeEntry | undefined): string | undefined {
  if (entry === undefined) {
    return "";
  }
  if (entry.kind === "other") {
    return undefined;
  }
  if (entry.kind === "symlink") {
    return UTF8.decode(entry.bytes);
  }
  if (entry.bytes.includes(0)) {
    return undefined;
  }
  try {
    return UTF8.decode(entry.bytes);
  } catch {
    return undefined;
  }
}

function get(vector: ReadonlyMap<number, number>, key: number): number {
  return vector.get(key) ?? Number.NEGATIVE_INFINITY;
}

function backtrack(
  trace: readonly ReadonlyMap<number, number>[],
  before: readonly string[],
  after: readonly string[]
): readonly LineOperation[] {
  let x = before.length;
  let y = after.length;
  const operations: LineOperation[] = [];

  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const vector = trace[depth] as ReadonlyMap<number, number>;
    const diagonal = x - y;
    const previousDiagonal = diagonal === -depth ||
      (diagonal !== depth && get(vector, diagonal - 1) < get(vector, diagonal + 1))
      ? diagonal + 1
      : diagonal - 1;
    const previousX = depth === 0 ? 0 : Math.max(0, get(vector, previousDiagonal));
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      operations.push({ kind: "equal", line: before[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (depth === 0) {
      break;
    }
    if (x === previousX) {
      operations.push({ kind: "added", line: after[y - 1] as string });
      y -= 1;
    } else {
      operations.push({ kind: "removed", line: before[x - 1] as string });
      x -= 1;
    }
  }

  return operations.reverse();
}

function diffLines(before: readonly string[], after: readonly string[]): readonly LineOperation[] {
  const maximumDepth = before.length + after.length;
  const vector = new Map<number, number>([[1, 0]]);
  const trace: ReadonlyMap<number, number>[] = [];

  for (let depth = 0; depth <= maximumDepth; depth += 1) {
    trace.push(new Map(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x: number;
      if (
        diagonal === -depth ||
        (diagonal !== depth && get(vector, diagonal - 1) < get(vector, diagonal + 1))
      ) {
        x = Math.max(0, get(vector, diagonal + 1));
      } else {
        x = Math.max(0, get(vector, diagonal - 1)) + 1;
      }
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      vector.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrack(trace, before, after);
      }
    }
  }
  throw new Error("line diff failed to terminate");
}

function textChange(before: string, after: string, mode: WhitespaceMode): TextChange {
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  for (const operation of diffLines(lines(before), lines(after))) {
    if (operation.kind === "removed") {
      addCount(removed, normalizeLine(operation.line, mode));
    } else if (operation.kind === "added") {
      addCount(added, normalizeLine(operation.line, mode));
    }
  }
  return { kind: "text", removed, added };
}

function isEmptyTextChange(change: TextChange): boolean {
  return change.removed.size === 0 && change.added.size === 0;
}

function selected(path: string, paths: ReadonlySet<string> | undefined): boolean {
  return paths === undefined || paths.has(path);
}

async function actualChanges(
  fixtureRoot: string,
  workspaceRoot: string,
  mode: WhitespaceMode,
  paths: ReadonlySet<string> | undefined
): Promise<ReadonlyMap<string, FileChange>> {
  const beforeTree = await readWorkspaceTree(fixtureRoot);
  const afterTree = await readWorkspaceTree(workspaceRoot);
  const allPaths = [...new Set([...beforeTree.keys(), ...afterTree.keys()])].sort();
  const changes = new Map<string, FileChange>();

  for (const path of allPaths) {
    if (!selected(path, paths)) {
      continue;
    }
    const before = beforeTree.get(path);
    const after = afterTree.get(path);
    if (
      before?.kind === after?.kind &&
      before !== undefined &&
      after !== undefined &&
      hash(before.bytes) === hash(after.bytes)
    ) {
      continue;
    }

    const beforeText = decodeText(before);
    const afterText = decodeText(after);
    if (beforeText === undefined || afterText === undefined) {
      changes.set(path, {
        kind: "binary",
        finalSha256: after === undefined ? "/dev/null" : hash(after.bytes)
      });
      continue;
    }
    const change = textChange(beforeText, afterText, mode);
    if (!isEmptyTextChange(change)) {
      changes.set(path, change);
    }
  }
  return changes;
}

function patchHeaderPath(raw: string): string {
  const withoutTimestamp = raw.split("\t", 1)[0] as string;
  if (withoutTimestamp === "/dev/null") {
    return withoutTimestamp;
  }
  let decoded = withoutTimestamp;
  if (decoded.startsWith("\"") && decoded.endsWith("\"")) {
    try {
      decoded = JSON.parse(decoded) as string;
    } catch {
      return invalidPatch(`invalid quoted patch path ${withoutTimestamp}`);
    }
  }
  if (decoded.startsWith("a/") || decoded.startsWith("b/")) {
    decoded = decoded.slice(2);
  }
  return validateWorkspacePath(decoded, "expected patch path");
}

function hunkCounts(header: string): { readonly oldCount: number; readonly newCount: number } {
  const match = /^@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@(?: .*)?$/u.exec(header);
  if (match === null) {
    return invalidPatch(`malformed hunk header ${JSON.stringify(header)}`);
  }
  return {
    oldCount: match[1] === undefined ? 1 : Number(match[1]),
    newCount: match[2] === undefined ? 1 : Number(match[2])
  };
}

function newExpectedState(path: string): ExpectedFileState {
  return {
    path,
    text: { kind: "text", removed: new Map(), added: new Map() },
    binarySha256: undefined,
    sawHunk: false,
    sawBinaryMarker: false
  };
}

export function parseExpectedPatch(
  source: string,
  mode: WhitespaceMode
): ReadonlyMap<string, FileChange> {
  const patchLines = source.split(/\r?\n/u);
  const changes = new Map<string, FileChange>();
  let current: ExpectedFileState | undefined;
  let index = 0;

  const finishCurrent = (): void => {
    if (current === undefined) {
      return;
    }
    if (current.sawBinaryMarker) {
      if (current.binarySha256 === undefined) {
        invalidPatch(`binary patch for ${current.path} lacks Assay-Binary-SHA256 sidecar`);
      }
      changes.set(current.path, { kind: "binary", finalSha256: current.binarySha256 });
    } else if (current.sawHunk) {
      changes.set(current.path, current.text);
    } else {
      invalidPatch(`patch for ${current.path} has neither a hunk nor a binary marker`);
    }
    current = undefined;
  };

  while (index < patchLines.length) {
    const line = patchLines[index] as string;
    if (line === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      finishCurrent();
      index += 1;
      continue;
    }
    if (line.startsWith("--- ")) {
      finishCurrent();
      const oldPath = patchHeaderPath(line.slice(4));
      const next = patchLines[index + 1];
      if (next === undefined || !next.startsWith("+++ ")) {
        invalidPatch("a --- file header must be followed by +++");
      }
      const newPath = patchHeaderPath(next.slice(4));
      if (oldPath === "/dev/null" && newPath === "/dev/null") {
        invalidPatch("both patch paths cannot be /dev/null");
      }
      const path = newPath === "/dev/null" ? oldPath : newPath;
      if (changes.has(path)) {
        invalidPatch(`duplicate file section for ${path}`);
      }
      current = newExpectedState(path);
      index += 2;
      continue;
    }
    if (line.startsWith("@@")) {
      if (current === undefined || current.sawBinaryMarker) {
        invalidPatch("hunk appears outside a textual file section");
      }
      const declared = hunkCounts(line);
      let oldCount = 0;
      let newCount = 0;
      current.sawHunk = true;
      index += 1;
      while (index < patchLines.length) {
        const content = patchLines[index] as string;
        if (content.startsWith("@@") || content.startsWith("diff --git ") || content.startsWith("--- ")) {
          break;
        }
        if (content === "\\ No newline at end of file") {
          index += 1;
          continue;
        }
        const prefix = content[0];
        const body = content.slice(1);
        if (prefix === " ") {
          oldCount += 1;
          newCount += 1;
        } else if (prefix === "-") {
          oldCount += 1;
          addCount(current.text.removed, normalizeLine(body, mode));
        } else if (prefix === "+") {
          newCount += 1;
          addCount(current.text.added, normalizeLine(body, mode));
        } else if (content === "" && oldCount === declared.oldCount && newCount === declared.newCount) {
          index += 1;
          break;
        } else {
          invalidPatch(`invalid hunk content ${JSON.stringify(content)}`);
        }
        index += 1;
      }
      if (oldCount !== declared.oldCount || newCount !== declared.newCount) {
        invalidPatch(
          `hunk line counts do not match header: expected ${declared.oldCount}/${declared.newCount}, got ${oldCount}/${newCount}`
        );
      }
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      if (current === undefined || current.sawHunk) {
        invalidPatch("binary marker appears outside a binary file section");
      }
      current.sawBinaryMarker = true;
      index += 1;
      continue;
    }
    if (line.startsWith("Assay-Binary-SHA256: ")) {
      if (current === undefined || !current.sawBinaryMarker || current.binarySha256 !== undefined) {
        invalidPatch("binary SHA-256 sidecar is misplaced or duplicated");
      }
      const value = line.slice("Assay-Binary-SHA256: ".length);
      if (value !== "/dev/null" && !HASH_PATTERN.test(value)) {
        invalidPatch("binary SHA-256 sidecar must be 64 lowercase hexadecimal characters or /dev/null");
      }
      current.binarySha256 = value;
      index += 1;
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      index += 1;
      continue;
    }
    invalidPatch(`unrecognized patch line ${JSON.stringify(line)}`);
  }
  finishCurrent();
  if (changes.size === 0) {
    invalidPatch("expected patch contains no file changes");
  }
  return changes;
}

function mapEntries(map: ReadonlyMap<string, number>): readonly (readonly [string, number])[] {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

function comparable(change: FileChange): unknown {
  return change.kind === "binary"
    ? { kind: change.kind, finalSha256: change.finalSha256 }
    : { kind: change.kind, removed: mapEntries(change.removed), added: mapEntries(change.added) };
}

function filterChanges(
  changes: ReadonlyMap<string, FileChange>,
  paths: ReadonlySet<string> | undefined
): ReadonlyMap<string, FileChange> {
  if (paths === undefined) {
    return changes;
  }
  return new Map([...changes].filter(([path]) => paths.has(path)));
}

function mismatchDetails(
  actual: ReadonlyMap<string, FileChange>,
  expected: ReadonlyMap<string, FileChange>
): {
  readonly matches: boolean;
  readonly observed: unknown;
} {
  const paths = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const mismatches: unknown[] = [];
  for (const path of paths) {
    const actualValue = actual.get(path);
    const expectedValue = expected.get(path);
    const actualComparable = actualValue === undefined ? undefined : comparable(actualValue);
    const expectedComparable = expectedValue === undefined ? undefined : comparable(expectedValue);
    if (JSON.stringify(actualComparable) !== JSON.stringify(expectedComparable)) {
      mismatches.push({ path, actual: actualComparable ?? "unchanged", expected: expectedComparable ?? "unchanged" });
    }
  }
  return {
    matches: mismatches.length === 0,
    observed: mismatches.length === 0 ? { matches: true } : { matches: false, mismatches }
  };
}

export async function validateDiffMatchesAssertion(
  spec: DiffMatchesAssertionSpec,
  projectRoot: string
): Promise<void> {
  const bytes = await readWorkspaceFile(projectRoot, spec.expected, MAX_PATCH_BYTES).catch((error: unknown) => {
    throw new AssertionSpecError(
      "diff-patch",
      `task_invalid: expected patch cannot be read: ${error instanceof Error ? error.message : "unknown error"}`
    );
  });
  let source: string;
  try {
    source = UTF8.decode(bytes);
  } catch {
    throw new AssertionSpecError("diff-patch", "task_invalid: expected patch is not valid UTF-8");
  }
  parseExpectedPatch(source, spec.ignore_whitespace ?? "trailing");
}

export async function evaluateDiffMatches(
  spec: DiffMatchesAssertionSpec,
  roots: {
    readonly fixtureRoot: string;
    readonly workspaceRoot: string;
    readonly projectRoot: string;
  }
): Promise<{ readonly matches: boolean; readonly observed: unknown }> {
  if (typeof roots.fixtureRoot !== "string" || roots.fixtureRoot.length === 0) {
    throw new Error("diff_matches requires the materialized fixture root");
  }
  const mode = spec.ignore_whitespace ?? "trailing";
  const selectedPaths = spec.paths === undefined ? undefined : new Set(spec.paths);
  const patchBytes = await readWorkspaceFile(roots.projectRoot, spec.expected, MAX_PATCH_BYTES);
  const patchSource = UTF8.decode(patchBytes);
  const expected = filterChanges(parseExpectedPatch(patchSource, mode), selectedPaths);
  const actual = await actualChanges(
    roots.fixtureRoot,
    roots.workspaceRoot,
    mode,
    selectedPaths
  );
  return mismatchDetails(actual, expected);
}
