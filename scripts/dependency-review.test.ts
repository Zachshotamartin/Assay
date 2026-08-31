import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

interface LockEntry {
  readonly version?: string;
  readonly link?: boolean;
}

interface PackageLock {
  readonly packages: Readonly<Record<string, LockEntry>>;
}

function nameFromLockPath(path: string): string | undefined {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const remainder = path.slice(index + marker.length);
  const parts = remainder.split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function lockedPackages(): Promise<ReadonlySet<string>> {
  const lock = JSON.parse(await readFile(`${root}/package-lock.json`, "utf8")) as PackageLock;
  const packages = new Set<string>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = nameFromLockPath(path);
    if (name !== undefined && entry.version !== undefined && entry.link !== true) {
      packages.add(`${name}@${entry.version}`);
    }
  }
  return packages;
}

interface ReviewRow {
  readonly id: string;
  readonly cells: readonly string[];
}

async function reviewRows(): Promise<readonly ReviewRow[]> {
  const source = await readFile(`${root}/docs/DEPENDENCY_REVIEW.md`, "utf8");
  return source
    .split(/\r?\n/u)
    .filter((line) => /^\| `[^`]+` \|/u.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { id: (cells[0] ?? "").replace(/^`|`$/gu, ""), cells };
    });
}

describe("R0 dependency review baseline", () => {
  it("reviews every exact lockfile package once with no stale rows", async () => {
    const locked = [...(await lockedPackages())].sort();
    const reviewed = (await reviewRows()).map(({ id }) => id).sort();

    expect(new Set(reviewed).size).toBe(reviewed.length);
    expect(reviewed).toEqual(locked);
  });

  it("records every required intake dimension for every dependency", async () => {
    for (const row of await reviewRows()) {
      expect(row.cells, row.id).toHaveLength(8);
      for (const cell of row.cells) {
        expect(cell.trim(), row.id).not.toBe("");
        expect(cell, row.id).not.toMatch(/\b(?:unknown|todo|tbd)\b/iu);
      }
      expect(row.cells[1], row.id).toMatch(/^(?:direct|transitive|optional platform)$/u);
      expect(row.cells[5], row.id).toMatch(/^(?:none|JavaScript|native binary)$/u);
      expect(row.cells[6], row.id).toMatch(/^(?:tiny|small|medium|large)$/u);
    }
  });
});
