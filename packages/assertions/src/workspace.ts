import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceEntryKind = "file" | "dir" | "symlink" | "other";

export type InspectedWorkspacePath =
  | { readonly status: "absent" }
  | { readonly status: "blocked_symlink"; readonly path: string }
  | {
      readonly status: "present";
      readonly path: string;
      readonly kind: WorkspaceEntryKind;
      readonly stats: Stats;
    };

export interface WorkspaceTreeEntry {
  readonly kind: Exclude<WorkspaceEntryKind, "dir">;
  readonly bytes: Uint8Array;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function kindOf(stats: Stats): WorkspaceEntryKind {
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "dir";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function canonicalRoot(root: string): Promise<string> {
  const canonical = await realpath(resolve(root));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error(`assertion root is not a directory: ${root}`);
  }
  return canonical;
}

export async function inspectWorkspacePath(
  root: string,
  relativePath: string
): Promise<InspectedWorkspacePath> {
  const canonical = await canonicalRoot(root);
  const segments = relativePath.split("/").filter((segment) => segment !== ".");
  let current = canonical;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    if (!contained(canonical, current)) {
      throw new Error(`assertion path escaped its root: ${relativePath}`);
    }
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return { status: "absent" };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() && index !== segments.length - 1) {
      return { status: "blocked_symlink", path: current };
    }
    if (index === segments.length - 1) {
      return { status: "present", path: current, kind: kindOf(metadata), stats: metadata };
    }
  }
  const metadata = await lstat(canonical);
  return { status: "present", path: canonical, kind: "dir", stats: metadata };
}

export async function readWorkspaceFile(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  const inspected = await inspectWorkspacePath(root, relativePath);
  if (inspected.status === "absent") {
    throw Object.assign(new Error(`file is absent: ${relativePath}`), { code: "ENOENT" });
  }
  if (inspected.status === "blocked_symlink") {
    throw new Error(`path traverses a symlink: ${relativePath}`);
  }
  if (inspected.kind !== "file") {
    throw new Error(`path is not a regular file: ${relativePath}`);
  }
  if (inspected.stats.size > maxBytes) {
    throw Object.assign(new Error(`file exceeds ${maxBytes} bytes: ${relativePath}`), {
      code: "ASSERTION_FILE_TOO_LARGE",
      size: inspected.stats.size,
      limit: maxBytes
    });
  }

  const handle = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw Object.assign(new Error(`file exceeds ${maxBytes} bytes: ${relativePath}`), {
        code: "ASSERTION_FILE_TOO_LARGE",
        size: bytes.byteLength,
        limit: maxBytes
      });
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceTree(root: string): Promise<ReadonlyMap<string, WorkspaceTreeEntry>> {
  const canonical = await canonicalRoot(root);
  const entries = new Map<string, WorkspaceTreeEntry>();

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const childPath = resolve(directory, child.name);
      if (!contained(canonical, childPath)) {
        throw new Error(`workspace traversal escaped its root at ${childPath}`);
      }
      const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      const metadata = await lstat(childPath);
      if (metadata.isDirectory()) {
        await visit(childPath, relativePath);
      } else if (metadata.isSymbolicLink()) {
        entries.set(relativePath, {
          kind: "symlink",
          bytes: new TextEncoder().encode(await readlink(childPath))
        });
      } else if (metadata.isFile()) {
        const handle = await open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          entries.set(relativePath, { kind: "file", bytes: await handle.readFile() });
        } finally {
          await handle.close();
        }
      } else {
        entries.set(relativePath, { kind: "other", bytes: new Uint8Array() });
      }
    }
  };

  await visit(canonical, "");
  return entries;
}
