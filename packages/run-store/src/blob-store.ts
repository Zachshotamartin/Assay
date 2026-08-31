import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { AssayError, createBlobHash, type BlobHash } from "@assay/contracts";

import type { StorePaths } from "./lock.js";
import type { StoreFaultMarker } from "./types.js";

let temporaryCounter = 0;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function sha256Blob(bytes: Uint8Array): BlobHash {
  return createBlobHash(createHash("sha256").update(bytes).digest("hex"));
}

export class BlobIntegrityError extends Error {
  readonly blobHash: BlobHash;
  readonly actualHash: string | null;
  readonly objectPath: string;
  readonly missing: boolean;

  constructor(
    blobHash: BlobHash,
    objectPath: string,
    actualHash: string | null,
    missing: boolean
  ) {
    super(missing ? "blob object is missing" : "blob content hash does not match its address");
    this.name = "BlobIntegrityError";
    this.blobHash = blobHash;
    this.actualHash = actualHash;
    this.objectPath = objectPath;
    this.missing = missing;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureShard(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: blob shard ${JSON.stringify(path)} is not a private real directory; no blob was written; run assay doctor`
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
}

function invokeFault(
  injector: ((marker: StoreFaultMarker) => void) | undefined,
  marker: StoreFaultMarker
): void {
  if (injector === undefined) {
    return;
  }
  try {
    injector(marker);
  } catch (cause) {
    throw new AssayError(
      "internal_invariant",
      `internal_invariant: injected store fault hook threw at ${marker}; authoritative state remains bounded by the surrounding atomic step; remove the test-only hook`,
      { cause }
    );
  }
}

export class ContentAddressedBlobStore {
  readonly #paths: StorePaths;
  readonly #processId: number;
  readonly #faultInjector: ((marker: StoreFaultMarker) => void) | undefined;

  constructor(
    paths: StorePaths,
    processId: number,
    faultInjector: ((marker: StoreFaultMarker) => void) | undefined
  ) {
    this.#paths = paths;
    this.#processId = processId;
    this.#faultInjector = faultInjector;
  }

  objectPath(hash: BlobHash): string {
    return join(this.#paths.objectsPath, hash.slice(0, 2), hash);
  }

  async cleanInterruptedTemporaryFiles(): Promise<void> {
    for (const name of await readdir(this.#paths.temporaryPath)) {
      const path = join(this.#paths.temporaryPath, name);
      const metadata = await lstat(path);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new AssayError(
          "storage_corrupt",
          `storage_corrupt: unexpected non-file entry in blob temporary directory ${JSON.stringify(path)}; no evidence changed; run assay doctor`
        );
      }
      await rm(path, { force: true });
    }
  }

  async put(bytes: Uint8Array): Promise<BlobHash> {
    const hash = sha256Blob(bytes);
    const shard = join(this.#paths.objectsPath, hash.slice(0, 2));
    const destination = join(shard, hash);
    await ensureShard(shard);

    try {
      const existing = await readFile(destination);
      const existingHash = sha256Blob(existing);
      if (existingHash !== hash || !existing.equals(bytes)) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: existing object at ${hash} differs from bytes with the same content address; no object was overwritten; quarantine the store with assay doctor`
        );
      }
      return hash;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    temporaryCounter += 1;
    const temporary = join(
      this.#paths.temporaryPath,
      `${hash}.${this.#processId}.${temporaryCounter}.tmp`
    );
    let renamed = false;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      const temporaryHandle = await open(temporary, "r+");
      try {
        await temporaryHandle.chmod(0o600);
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      invokeFault(this.#faultInjector, "before_blob_rename");
      await rename(temporary, destination);
      renamed = true;
      await syncDirectory(shard);
      invokeFault(this.#faultInjector, "after_blob_rename");
      return hash;
    } finally {
      if (!renamed) {
        await unlink(temporary).catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
    }
  }

  async getVerified(hash: BlobHash): Promise<Uint8Array> {
    const path = this.objectPath(hash);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new BlobIntegrityError(hash, path, null, true);
      }
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: blob ${hash} could not be read; no evidence changed; run assay doctor`,
        { cause: error }
      );
    }
    const actualHash = sha256Blob(bytes);
    if (actualHash !== hash) {
      throw new BlobIntegrityError(hash, path, actualHash, false);
    }
    return new Uint8Array(bytes);
  }

  async fsyncVerified(hash: BlobHash): Promise<void> {
    await this.getVerified(hash);
    const handle = await open(this.objectPath(hash), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async quarantineCorruptObject(
    hash: BlobHash,
    timestampToken: string
  ): Promise<string | null> {
    const source = this.objectPath(hash);
    try {
      await stat(source);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let suffix = 0;
    while (suffix < 1_000) {
      const ending = suffix === 0 ? "" : `.${suffix}`;
      const destination = join(
        this.#paths.quarantineObjectsPath,
        `${hash}.${timestampToken}${ending}`
      );
      try {
        await lstat(destination);
        suffix += 1;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
        await rename(source, destination);
        await syncDirectory(this.#paths.quarantineObjectsPath);
        return destination;
      }
    }
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: no unique quarantine path was available for blob ${hash}; corrupt bytes remain preserved; run assay doctor`
    );
  }
}
