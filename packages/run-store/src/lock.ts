import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { join, parse, resolve } from "node:path";

import { AssayError, canonicalJson, type Clock } from "@assay/contracts";

import { MAX_LOCK_FILE_BYTES, type StoreLockPolicy } from "./types.js";

const DEFAULT_LOCK_POLICY: StoreLockPolicy = { maxAttempts: 5, retryDelayMs: 25 };

interface LockContents {
  readonly pid: number;
  readonly acquiredAtUtc: string;
}

export interface StorePaths {
  readonly projectRoot: string;
  readonly storeDirectory: string;
  readonly databasePath: string;
  readonly objectsPath: string;
  readonly temporaryPath: string;
  readonly quarantinePath: string;
  readonly quarantineObjectsPath: string;
  readonly writerLockPath: string;
}

export interface AcquiredWriterLock {
  readonly ownerPid: number;
  release(): Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function permissionsError(path: string): AssayError {
  return new AssayError(
    "storage_corrupt",
    `storage_corrupt: refused insecure store path ${JSON.stringify(path)}; no store state changed; run assay doctor and remove group/world write permissions`
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw permissionsError(path);
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw permissionsError(path);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { mode: 0o700, recursive: true });
    created = true;
  }

  if (created) {
    await chmod(path, 0o700);
  }
}

export async function resolveStorePaths(
  projectRoot: string,
  configuredStorePath = ".assay"
): Promise<StorePaths> {
  const absoluteProjectRoot = resolve(projectRoot);
  const projectMetadata = await lstat(absoluteProjectRoot).catch((cause: unknown) => {
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: project root ${JSON.stringify(absoluteProjectRoot)} is unavailable; no store state changed; verify the project path`,
      { cause }
    );
  });
  if (!projectMetadata.isDirectory() || projectMetadata.isSymbolicLink()) {
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: project root ${JSON.stringify(absoluteProjectRoot)} is not a real directory; no store state changed; verify the project path`
    );
  }

  if (configuredStorePath.length === 0 || configuredStorePath.includes("\0")) {
    throw new AssayError(
      "invalid_configuration",
      "invalid_configuration: storePath must be a non-empty filesystem path without NUL bytes; no store state changed; correct storePath"
    );
  }
  const storeDirectory = resolve(absoluteProjectRoot, configuredStorePath);
  if (storeDirectory === parse(storeDirectory).root) {
    throw new AssayError(
      "invalid_configuration",
      "invalid_configuration: storePath must not be a filesystem root; no store state changed; choose a dedicated private directory"
    );
  }
  const objectsPath = join(storeDirectory, "objects");
  const temporaryPath = join(storeDirectory, "tmp");
  const quarantinePath = join(storeDirectory, "quarantine");
  const quarantineObjectsPath = join(quarantinePath, "objects");
  await ensurePrivateDirectory(storeDirectory);
  await ensurePrivateDirectory(objectsPath);
  await ensurePrivateDirectory(temporaryPath);
  await ensurePrivateDirectory(quarantinePath);
  await ensurePrivateDirectory(quarantineObjectsPath);

  return {
    projectRoot: absoluteProjectRoot,
    storeDirectory,
    databasePath: join(storeDirectory, "assay.db"),
    objectsPath,
    temporaryPath,
    quarantinePath,
    quarantineObjectsPath,
    writerLockPath: join(storeDirectory, "writer.lock")
  };
}

function validatePolicy(policy: StoreLockPolicy | undefined): StoreLockPolicy {
  const resolved = policy ?? DEFAULT_LOCK_POLICY;
  if (
    !Number.isSafeInteger(resolved.maxAttempts) ||
    resolved.maxAttempts < 1 ||
    resolved.maxAttempts > 100 ||
    !Number.isSafeInteger(resolved.retryDelayMs) ||
    resolved.retryDelayMs < 0 ||
    resolved.retryDelayMs > 1_000
  ) {
    throw new AssayError(
      "invalid_configuration",
      "invalid_configuration: store lock policy is outside its bounded range; no store state changed; use 1..100 attempts and 0..1000 ms delay"
    );
  }
  return resolved;
}

async function syncLock(handle: FileHandle, contents: LockContents): Promise<void> {
  await handle.writeFile(canonicalJson(contents), { encoding: "utf8" });
  await handle.sync();
  await handle.chmod(0o600);
}

async function readLock(path: string): Promise<LockContents | undefined> {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_LOCK_FILE_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Number.isSafeInteger((parsed as Record<string, unknown>)["pid"]) ||
      ((parsed as Record<string, unknown>)["pid"] as number) <= 0 ||
      typeof (parsed as Record<string, unknown>)["acquiredAtUtc"] !== "string"
    ) {
      return undefined;
    }
    return {
      pid: (parsed as Record<string, unknown>)["pid"] as number,
      acquiredAtUtc: (parsed as Record<string, unknown>)["acquiredAtUtc"] as string
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function removeStaleLock(path: string, observedPid: number): Promise<boolean> {
  const current = await readLock(path);
  if (current?.pid !== observedPid || isProcessAlive(observedPid)) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function acquireWriterLock(
  paths: StorePaths,
  processId: number,
  clock: Clock,
  policyInput: StoreLockPolicy | undefined
): Promise<AcquiredWriterLock> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new AssayError(
      "invalid_configuration",
      "invalid_configuration: injected process id must be a positive safe integer; no store state changed; repair the composition root"
    );
  }
  const policy = validatePolicy(policyInput);
  let observedOwner: number | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const handle = await open(paths.writerLockPath, "wx", 0o600);
      try {
        await syncLock(handle, { pid: processId, acquiredAtUtc: clock.wallTime() });
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        ownerPid: processId,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          const current = await readLock(paths.writerLockPath);
          if (current?.pid !== processId) {
            return;
          }
          await unlink(paths.writerLockPath).catch((error: unknown) => {
            if (!isNodeError(error) || error.code !== "ENOENT") {
              throw error;
            }
          });
        }
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new AssayError(
          "storage_locked",
          `storage_locked: writer lock could not be created at ${JSON.stringify(paths.writerLockPath)}; no store state changed; inspect permissions with assay doctor`,
          { cause: error }
        );
      }
    }

    const owner = await readLock(paths.writerLockPath);
    observedOwner = owner?.pid;
    if (owner !== undefined && (await removeStaleLock(paths.writerLockPath, owner.pid))) {
      continue;
    }
    if (attempt < policy.maxAttempts) {
      await delay(policy.retryDelayMs);
    }
  }

  const ownerText = observedOwner === undefined ? "unknown" : String(observedOwner);
  throw new AssayError(
    "storage_locked",
    `storage_locked: store writer lock is held by process ${ownerText} after ${policy.maxAttempts} bounded attempts; no store state changed; wait for that process or inspect the stale lock with assay doctor`
  );
}
