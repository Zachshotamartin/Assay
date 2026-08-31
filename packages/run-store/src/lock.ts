import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { AssayError, canonicalJson, type Clock } from "@assay/contracts";

import {
  MAX_LOCK_FILE_BYTES,
  MAX_STORE_CONFIG_BYTES,
  STORE_CREATED_BY_VERSION,
  STORE_SCHEMA_VERSION,
  type StoreLockPolicy
} from "./types.js";

const DEFAULT_LOCK_POLICY: StoreLockPolicy = { maxAttempts: 5, retryDelayMs: 25 };

interface LockContents {
  readonly pid: number;
  readonly acquiredAtUtc: string;
}

interface StoreIdentityMarker {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly createdByVersion: string;
  readonly storeId: string;
}

export interface StorePaths {
  readonly projectRoot: string;
  readonly storeDirectory: string;
  readonly configPath: string;
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

function invalidStorePath(configuredStorePath: string): AssayError {
  return new AssayError(
    "invalid_configuration",
    `invalid_configuration: storePath ${JSON.stringify(configuredStorePath)} must name a project-local directory without symlinked ancestors; no store state changed; choose a relative path contained by the project root`
  );
}

async function rejectSymlinkedStoreAncestors(
  projectRoot: string,
  storeDirectory: string,
  configuredStorePath: string
): Promise<void> {
  const pathFromRoot = relative(projectRoot, storeDirectory);
  const segments = pathFromRoot.split(sep).filter((segment) => segment !== "");
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw invalidStorePath(configuredStorePath);
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw invalidStorePath(configuredStorePath);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
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
  if (isAbsolute(configuredStorePath)) {
    throw invalidStorePath(configuredStorePath);
  }
  const storeDirectory = resolve(absoluteProjectRoot, configuredStorePath);
  const pathFromProject = relative(absoluteProjectRoot, storeDirectory);
  if (
    storeDirectory === parse(storeDirectory).root ||
    pathFromProject === "" ||
    pathFromProject === ".." ||
    pathFromProject.startsWith(`..${sep}`) ||
    isAbsolute(pathFromProject)
  ) {
    throw invalidStorePath(configuredStorePath);
  }
  await rejectSymlinkedStoreAncestors(
    absoluteProjectRoot,
    storeDirectory,
    configuredStorePath
  );
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
    configPath: join(storeDirectory, "config"),
    databasePath: join(storeDirectory, "assay.db"),
    objectsPath,
    temporaryPath,
    quarantinePath,
    quarantineObjectsPath,
    writerLockPath: join(storeDirectory, "writer.lock")
  };
}

function storeIdentityError(message: string, cause?: unknown): AssayError {
  return new AssayError(
    "storage_corrupt",
    `storage_corrupt: store identity marker ${message}; no database record changed; inspect the config file with assay doctor`,
    cause === undefined ? undefined : { cause }
  );
}

function parseStoreIdentity(bytes: string): StoreIdentityMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (cause) {
    throw storeIdentityError("is not valid JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw storeIdentityError("must be a canonical JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "createdByVersion,schemaVersion,storeId" ||
    typeof record["createdByVersion"] !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record["createdByVersion"]) ||
    typeof record["storeId"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record["storeId"])
  ) {
    throw storeIdentityError("has an invalid schema, creator version, or store id");
  }
  if (!Number.isSafeInteger(record["schemaVersion"])) {
    throw storeIdentityError("has a non-integer schema version");
  }
  if (record["schemaVersion"] !== STORE_SCHEMA_VERSION) {
    throw new AssayError(
      "storage_migration_required",
      `storage_migration_required: store identity schema ${String(record["schemaVersion"])} does not match required schema ${STORE_SCHEMA_VERSION}; no state changed; run assay db migrate or upgrade the Assay binary`
    );
  }
  if (canonicalJson(parsed) !== bytes) {
    throw storeIdentityError("is not encoded as canonical JSON");
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    createdByVersion: record["createdByVersion"],
    storeId: record["storeId"]
  };
}

async function readStoreIdentity(paths: StorePaths): Promise<StoreIdentityMarker | undefined> {
  let metadata;
  try {
    metadata = await lstat(paths.configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw storeIdentityError("could not be inspected", error);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > MAX_STORE_CONFIG_BYTES
  ) {
    throw storeIdentityError(`at ${JSON.stringify(paths.configPath)} must be a private regular file no larger than ${MAX_STORE_CONFIG_BYTES} bytes`);
  }
  try {
    return parseStoreIdentity(await readFile(paths.configPath, "utf8"));
  } catch (error) {
    if (error instanceof AssayError) {
      throw error;
    }
    throw storeIdentityError("could not be read", error);
  }
}

function derivedStoreId(paths: StorePaths): string {
  return createHash("sha256")
    .update(canonicalJson({ kind: "assay-store", storeDirectory: paths.storeDirectory }), "utf8")
    .digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureStoreIdentityMarker(
  paths: StorePaths,
  processId: number
): Promise<StoreIdentityMarker> {
  const existing = await readStoreIdentity(paths);
  if (existing !== undefined) {
    return existing;
  }
  const marker: StoreIdentityMarker = {
    schemaVersion: STORE_SCHEMA_VERSION,
    createdByVersion: STORE_CREATED_BY_VERSION,
    storeId: derivedStoreId(paths)
  };
  const temporaryPath = `${paths.configPath}.${processId}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(canonicalJson(marker), { encoding: "utf8" });
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, paths.configPath);
    await syncDirectory(paths.storeDirectory);
    return marker;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw storeIdentityError("could not be created atomically", cause);
  }
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
