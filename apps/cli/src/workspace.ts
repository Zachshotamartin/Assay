import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJsonBytes, AssayError } from "@assay/contracts";
import { createJsonRedactionSession } from "@assay/redaction";

import type { PreparedFixture } from "./project.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface MaterializedWorkspace {
  readonly stagingRoot: string;
  readonly workspaceRoot: string;
  readonly fixtureRoot: string;
}

interface SnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function copyDirectoryTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const canonicalSource = await realpath(sourceRoot);
  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => codePointCompare(left.name, right.name));
    for (const entry of entries) {
      const source = join(sourceDirectory, entry.name);
      const destination = join(destinationDirectory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isDirectory()) {
        await visit(source, destination);
        await chmod(destination, metadata.mode & 0o777);
        continue;
      }
      if (metadata.isFile()) {
        await copyFile(source, destination);
        await chmod(destination, metadata.mode & 0o777);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await realpath(source).catch((cause: unknown) => {
          throw new AssayError(
            "fixture_unavailable",
            `fixture_unavailable: symlink ${JSON.stringify(relative(canonicalSource, source))} is dangling; no workspace was retained; replace it with an in-tree target`,
            { cause }
          );
        });
        if (!contained(canonicalSource, target)) {
          throw new AssayError(
            "fixture_unavailable",
            `fixture_unavailable: symlink ${JSON.stringify(relative(canonicalSource, source))} escapes its fixture; no workspace was retained; use an in-tree target`
          );
        }
        const mappedTarget = resolve(destinationRoot, relative(canonicalSource, target));
        const safeRelativeTarget = relative(dirname(destination), mappedTarget);
        await symlink(safeRelativeTarget, destination);
        continue;
      }
      throw new AssayError(
        "fixture_unavailable",
        `fixture_unavailable: fixture entry ${JSON.stringify(relative(canonicalSource, source))} is a special file; no workspace was retained; use regular files, directories, and in-tree symlinks only`
      );
    }
  };
  await visit(canonicalSource, destinationRoot);
}

export async function materializeFixture(fixture: PreparedFixture): Promise<MaterializedWorkspace> {
  if (fixture.kind === "archive") {
    throw new AssayError(
      "fixture_unavailable",
      "fixture_unavailable: verified archive extraction is owned by R2 and is not available in the R1 host runner; no workspace was created; use a local directory fixture for the simulated R1 path"
    );
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "assay-task-run-"));
  const workspaceRoot = join(stagingRoot, "workspace");
  try {
    await copyDirectoryTree(fixture.path, workspaceRoot);
    return { stagingRoot, workspaceRoot, fixtureRoot: fixture.path };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (error instanceof AssayError) throw error;
    throw new AssayError(
      "fixture_unavailable",
      "fixture_unavailable: directory fixture could not be materialized into a fresh workspace; no workspace was retained; inspect fixture permissions",
      { cause: error }
    );
  }
}

function encodedFile(bytes: Uint8Array): { readonly encoding: "utf8" | "base64"; readonly content: string } {
  try {
    return { encoding: "utf8", content: UTF8.decode(bytes) };
  } catch {
    return { encoding: "base64", content: Buffer.from(bytes).toString("base64") };
  }
}

export async function snapshotWorkspace(
  workspaceRoot: string,
  knownHashes: ReadonlySet<string>
): Promise<Uint8Array> {
  const canonical = await realpath(workspaceRoot);
  const entries: SnapshotEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => codePointCompare(left.name, right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        entries.push({ path: relativePath, kind: "file", ...encodedFile(await readFile(path)) });
      } else if (metadata.isSymbolicLink()) {
        const target = await realpath(path).catch((cause: unknown) => {
          throw new AssayError(
            "redaction_failed",
            `redaction_failed: workspace snapshot encountered dangling symlink ${JSON.stringify(relativePath)}; no snapshot was persisted; remove the dangling link`,
            { cause }
          );
        });
        if (!contained(canonical, target)) {
          throw new AssayError(
            "redaction_failed",
            `redaction_failed: workspace snapshot symlink ${JSON.stringify(relativePath)} resolves outside the workspace; no snapshot was persisted; remove the escaping link`
          );
        }
        entries.push({
          path: relativePath,
          kind: "symlink",
          encoding: "utf8",
          content: await readlink(path)
        });
      } else {
        throw new AssayError(
          "redaction_failed",
          `redaction_failed: workspace snapshot encountered special entry ${JSON.stringify(relativePath)}; no snapshot was persisted; remove the unsupported entry`
        );
      }
    }
  };
  await visit(canonical, "");

  const session = createJsonRedactionSession({
    location: "/workspace/entries",
    knownHashes
  });
  for (const entry of entries) session.write(entry);
  const redacted = session.finish().map((result) => {
    const value = result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AssayError("redaction_failed", "redaction_failed: snapshot redaction returned a non-object");
    }
    const entry = value as Readonly<Record<string, unknown>>;
    if (typeof entry["path"] !== "string" ||
        (entry["kind"] !== "file" && entry["kind"] !== "symlink") ||
        (entry["encoding"] !== "utf8" && entry["encoding"] !== "base64") ||
        typeof entry["content"] !== "string") {
      throw new AssayError(
        "redaction_failed",
        "redaction_failed: snapshot redaction invalidated a validated snapshot entry"
      );
    }
    return value;
  });
  return canonicalJsonBytes({ snapshotVersion: 1, entries: redacted });
}

export async function destroyWorkspace(workspace: MaterializedWorkspace | undefined): Promise<void> {
  if (workspace === undefined) return;
  await rm(workspace.stagingRoot, { recursive: true, force: true });
}
