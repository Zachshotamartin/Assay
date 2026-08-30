import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REVIEW_PREFIX = "Golden semantic review:";
const NON_REVIEWS = new Set([
  "n/a",
  "na",
  "none",
  "regenerated",
  "updated",
  "goldens updated",
  "no semantic change"
]);

function slash(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isGoldenPath(path: string): boolean {
  const normalized = `/${slash(path)}`;
  return (
    normalized.includes("/goldens/") ||
    normalized.includes("/golden/") ||
    /\/[^/]+\.golden\.[^/]+$/u.test(normalized)
  );
}

export function changedGoldenFiles(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(slash).filter(isGoldenPath))].sort((left, right) =>
    left.localeCompare(right)
  );
}

export function parseGoldenReviewNote(text: string): string {
  const matches = [...text.matchAll(/^Golden semantic review:[ \t]*(.+)$/gimu)];
  if (matches.length !== 1) {
    throw new Error(`golden changes require exactly one '${REVIEW_PREFIX} <substantive note>' line`);
  }
  const note = (matches[0]?.[1] ?? "").trim();
  if (note.length < 20 || NON_REVIEWS.has(note.toLocaleLowerCase("en-US"))) {
    throw new Error("Golden semantic review note must be substantive and explain the changed meaning");
  }
  return note;
}

export function assertGoldenReview(paths: readonly string[], reviewText: string): void {
  const goldens = changedGoldenFiles(paths);
  if (goldens.length === 0) {
    return;
  }
  try {
    parseGoldenReviewNote(reviewText);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid semantic review note";
    throw new Error(`${message}; changed goldens: ${goldens.join(", ")}`, { cause });
  }
}

function diffBase(): string {
  const configured = process.env["GOLDEN_POLICY_BASE_SHA"]?.trim();
  if (configured !== undefined && /^[0-9a-f]{7,40}$/u.test(configured)) {
    return configured;
  }
  return "HEAD^";
}

function changedFilesFromGit(): readonly string[] {
  const explicit = process.env["GOLDEN_POLICY_CHANGED_FILES"];
  if (explicit !== undefined) {
    return explicit.split(/\r?\n/u).filter((entry) => entry.trim() !== "");
  }
  try {
    return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", `${diffBase()}...HEAD`], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
      .split(/\r?\n/u)
      .filter((entry) => entry !== "");
  } catch (cause) {
    throw new Error("unable to determine changed files for the golden review policy", { cause });
  }
}

function main(): void {
  if (process.argv.slice(2).join(" ") !== "check") {
    throw new Error("usage: golden-policy check");
  }
  const files = changedFilesFromGit();
  assertGoldenReview(files, process.env["GOLDEN_POLICY_PR_BODY"] ?? "");
  process.stdout.write(`golden review policy: ok (${changedGoldenFiles(files).length} changed)\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
