import { chmod, lstat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import {
  AssayError,
  canonicalJson,
  createBlobHash,
  createRunId,
  createTaskRunId,
  parseAssayEvent,
  type AssayEvent,
  type BlobHash,
  type NewRunRecord,
  type NewTaskRunRecord,
  type RunId,
  type RunRecord,
  type RunStatus,
  type TaskRunId,
  type TaskRunRecord
} from "@assay/contracts";

import {
  BlobIntegrityError,
  ContentAddressedBlobStore,
  sha256Blob
} from "./blob-store.js";
import {
  acquireWriterLock,
  resolveStorePaths,
  type AcquiredWriterLock,
  type StorePaths
} from "./lock.js";
import { SCHEMA_V1_SQL } from "./schema.js";
import {
  MAX_RECORD_JSON_BYTES,
  STORE_SCHEMA_VERSION,
  type IntegrityReport,
  type QuarantineEntityType,
  type QuarantineRecord,
  type RunQuery,
  type RunStore,
  type RunStoreOptions,
  type RunSummary,
  type StoreDiagnostics,
  type StoredEvent,
  type StoreFaultMarker,
  type StoreLockPolicy
} from "./types.js";
import {
  validateRunRecordJson,
  validateTaskRunRecordJson
} from "./validation.js";

interface RunRow {
  readonly run_id: string;
  readonly created_at_utc: string;
  readonly suite_hash: string;
  readonly variant: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly model_id: string | null;
  readonly seed: number;
  readonly harness_version: string;
  readonly status: string;
  readonly record_json: string;
  readonly record_hash: string;
}

interface TaskRunRow {
  readonly task_run_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly task_content_hash: string;
  readonly attempt: number;
  readonly state: string;
  readonly outcome: string | null;
  readonly error_category: string | null;
  readonly record_json: string;
  readonly record_hash: string;
}

interface EventRow {
  readonly event_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly event_json: string;
}

interface QuarantineRow {
  readonly quarantine_id: number;
  readonly entity_type: QuarantineEntityType;
  readonly entity_id: string;
  readonly parent_run_id: string | null;
  readonly detected_at_utc: string;
  readonly category: "storage_corrupt";
  readonly reason: string;
  readonly detection_context_json: string;
  readonly original_record_json: string | null;
  readonly expected_hash: string | null;
  readonly actual_hash: string | null;
  readonly quarantined_blob_path: string | null;
}

interface SchemaVersionRow {
  readonly version: number;
}

interface NameRow {
  readonly name: string;
}

const REQUIRED_TABLES = [
  "events",
  "quarantine_records",
  "runs",
  "schema_meta",
  "task_runs"
] as const;
const DEFAULT_SQLITE_RETRY_POLICY: StoreLockPolicy = { maxAttempts: 5, retryDelayMs: 25 };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isSqliteError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function isBusyError(error: unknown): boolean {
  return (
    isSqliteError(error) &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

function isConstraintError(error: unknown): boolean {
  return isSqliteError(error) && error.code.startsWith("SQLITE_CONSTRAINT");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestampToken(timestamp: string): string {
  const token = timestamp.replace(/[^0-9A-Za-z.-]/gu, "-");
  return token.length === 0 ? "unknown-time" : token;
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
      `internal_invariant: injected store fault hook threw at ${marker}; the transaction retained its atomic boundary; remove the test-only hook`,
      { cause }
    );
  }
}

function ensureEventId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new AssayError(
      "internal_invariant",
      `internal_invariant: injected event id ${JSON.stringify(value.slice(0, 128))} is invalid; no event was written; repair the IdSource`
    );
  }
  return value;
}

function canonicalRecord(value: unknown): { readonly json: string; readonly hash: string } {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > MAX_RECORD_JSON_BYTES) {
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: record exceeds ${MAX_RECORD_JSON_BYTES} bytes; no row was written; move large payloads into the blob store`
    );
  }
  return { json, hash: sha256Text(json) };
}

async function renameIfPresent(source: string, destinationBase: string): Promise<string | null> {
  try {
    await lstat(source);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const destination = suffix === 0 ? destinationBase : `${destinationBase}.${suffix}`;
    try {
      await lstat(destination);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      await rename(source, destination);
      return destination;
    }
  }
  throw new AssayError(
    "storage_corrupt",
    `storage_corrupt: no unique quarantine name remained for ${JSON.stringify(source)}; original bytes remain in place; move the store aside manually before retrying`
  );
}

async function quarantineDatabaseFiles(paths: StorePaths, timestamp: string): Promise<void> {
  const token = timestampToken(timestamp);
  await renameIfPresent(paths.databasePath, `${paths.databasePath}.quarantined.${token}`);
  await renameIfPresent(`${paths.databasePath}-wal`, `${paths.databasePath}-wal.quarantined.${token}`);
  await renameIfPresent(`${paths.databasePath}-shm`, `${paths.databasePath}-shm.quarantined.${token}`);
}

function migrationRequired(foundVersion: number): AssayError {
  if (foundVersion < STORE_SCHEMA_VERSION) {
    return new AssayError(
      "storage_migration_required",
      `storage_migration_required: store schema ${foundVersion} is older than required schema ${STORE_SCHEMA_VERSION}; no state changed; run assay db migrate`
    );
  }
  return new AssayError(
    "storage_migration_required",
    `storage_migration_required: store schema ${foundVersion} is newer than supported schema ${STORE_SCHEMA_VERSION}; no state changed; upgrade the Assay binary`
  );
}

function configureDatabase(database: Database.Database): string {
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 0");
  const journalMode = database.pragma("journal_mode = WAL", { simple: true });
  if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: SQLite refused WAL mode and returned ${JSON.stringify(journalMode)}; no records were written; move the store to a WAL-capable local filesystem`
    );
  }
  return journalMode.toLowerCase();
}

function quickCheck(database: Database.Database): string {
  const result = database.pragma("quick_check", { simple: true });
  return typeof result === "string" ? result : String(result);
}

function userTableNames(database: Database.Database): ReadonlySet<string> {
  const tableRows = database
    .prepare<[], NameRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return new Set(tableRows.map(({ name }) => name));
}

function initializeOrValidateSchema(
  database: Database.Database,
  names: ReadonlySet<string>
): number {

  if (!names.has("schema_meta")) {
    if (names.size !== 0) {
      throw migrationRequired(0);
    }
    database.exec(`BEGIN IMMEDIATE;${SCHEMA_V1_SQL}COMMIT;`);
    return STORE_SCHEMA_VERSION;
  }

  const versions = database.prepare<[], SchemaVersionRow>("SELECT version FROM schema_meta").all();
  if (
    versions.length !== 1 ||
    !Number.isSafeInteger(versions[0]?.version)
  ) {
    throw new AssayError(
      "storage_corrupt",
      "storage_corrupt: schema_meta must contain exactly one integer version; no records were read; recover from the quarantined store copy"
    );
  }
  const version = versions[0]?.version as number;
  if (version !== STORE_SCHEMA_VERSION) {
    throw migrationRequired(version);
  }
  for (const table of REQUIRED_TABLES) {
    if (!names.has(table)) {
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: schema ${STORE_SCHEMA_VERSION} is missing required table ${table}; no records were read; recover from the quarantined store copy`
      );
    }
  }
  return version;
}

function validateExistingDatabasePath(path: string): Promise<boolean> {
  return lstat(path)
    .then((metadata) => {
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new AssayError(
          "storage_corrupt",
          `storage_corrupt: database ${JSON.stringify(path)} must be a private regular file with mode 0600; no state changed; run assay doctor`
        );
      }
      return true;
    })
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

function rowProjectionMatchesRun(row: RunRow, record: RunRecord): boolean {
  return (
    row.run_id === record.runId &&
    row.created_at_utc === record.createdAtUtc &&
    row.suite_hash === record.suiteHash &&
    row.variant === record.variant &&
    row.adapter_id === record.adapterId &&
    row.adapter_version === record.adapterVersion &&
    row.model_id === record.modelId &&
    row.seed === record.seed &&
    row.harness_version === record.harnessVersion &&
    row.status === record.status
  );
}

function rowProjectionMatchesTaskRun(row: TaskRunRow, record: TaskRunRecord): boolean {
  return (
    row.task_run_id === record.taskRunId &&
    row.run_id === record.runId &&
    row.task_id === record.taskId &&
    row.task_content_hash === record.taskContentHash &&
    row.attempt === record.attempt &&
    row.state === record.state &&
    row.outcome === record.outcome &&
    row.error_category === record.errorCategory
  );
}

function quarantineFromRow(row: QuarantineRow): QuarantineRecord {
  let parentRunId: RunId | null = null;
  if (row.parent_run_id !== null) {
    try {
      parentRunId = createRunId(row.parent_run_id);
    } catch {
      parentRunId = null;
    }
  }
  return {
    quarantineId: row.quarantine_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    parentRunId,
    detectedAtUtc: row.detected_at_utc,
    category: row.category,
    reason: row.reason,
    detectionContextJson: row.detection_context_json,
    originalRecordJson: row.original_record_json,
    expectedHash: row.expected_hash,
    actualHash: row.actual_hash,
    quarantinedBlobPath: row.quarantined_blob_path
  };
}

class SqliteRunStore implements RunStore {
  readonly #database: Database.Database;
  readonly #paths: StorePaths;
  readonly #writerLock: AcquiredWriterLock;
  readonly #options: RunStoreOptions;
  readonly #blobStore: ContentAddressedBlobStore;
  readonly #journalMode: string;
  readonly #schemaVersion: number;
  readonly #retryPolicy: StoreLockPolicy;
  #closed = false;

  constructor(
    database: Database.Database,
    paths: StorePaths,
    writerLock: AcquiredWriterLock,
    options: RunStoreOptions,
    journalMode: string,
    schemaVersion: number
  ) {
    this.#database = database;
    this.#paths = paths;
    this.#writerLock = writerLock;
    this.#options = options;
    this.#journalMode = journalMode;
    this.#schemaVersion = schemaVersion;
    this.#retryPolicy = options.lockPolicy ?? DEFAULT_SQLITE_RETRY_POLICY;
    this.#blobStore = new ContentAddressedBlobStore(
      paths,
      options.processId,
      options.faultInjector
    );
  }

  #assertOpen(): void {
    if (this.#closed || !this.#database.open) {
      throw new AssayError(
        "storage_corrupt",
        "storage_corrupt: run store is closed; no state changed; open a fresh store handle"
      );
    }
  }

  async #writeTransaction<T>(operation: () => T): Promise<T> {
    this.#assertOpen();
    const transaction = this.#database.transaction(operation);
    for (let attempt = 1; attempt <= this.#retryPolicy.maxAttempts; attempt += 1) {
      try {
        return transaction.immediate();
      } catch (error) {
        if (!isBusyError(error)) {
          if (error instanceof AssayError || isConstraintError(error)) {
            throw error;
          }
          if (isSqliteError(error)) {
            throw new AssayError(
              "storage_corrupt",
              "storage_corrupt: SQLite rejected an atomic store write; its transaction rolled back with no partial row; inspect assay doctor",
              { cause: error }
            );
          }
          throw new AssayError(
            "internal_invariant",
            "internal_invariant: store transaction callback failed outside a classified SQLite condition; its transaction rolled back; inspect debug diagnostics",
            { cause: error }
          );
        }
        if (attempt < this.#retryPolicy.maxAttempts) {
          await delay(this.#retryPolicy.retryDelayMs);
        }
      }
    }
    throw new AssayError(
      "storage_locked",
      `storage_locked: SQLite writer remained locked after ${this.#retryPolicy.maxAttempts} bounded attempts while Assay process ${this.#options.processId} held the store lease; no partial transaction committed; retry after the competing writer exits`
    );
  }

  #read<T>(operation: () => T): T {
    this.#assertOpen();
    try {
      return operation();
    } catch (error) {
      if (error instanceof AssayError) {
        throw error;
      }
      if (isBusyError(error)) {
        throw new AssayError(
          "storage_locked",
          "storage_locked: SQLite could not obtain a bounded read snapshot; no state changed; retry after the writer finishes",
          { cause: error }
        );
      }
      throw new AssayError(
        "storage_corrupt",
        "storage_corrupt: SQLite failed while reading store bytes; no unverified record was served; run assay doctor",
        { cause: error }
      );
    }
  }

  #runRows(): readonly RunRow[] {
    return this.#read(() =>
      this.#database
        .prepare<[], RunRow>(
          "SELECT run_id, created_at_utc, suite_hash, variant, adapter_id, adapter_version, model_id, seed, harness_version, status, record_json, record_hash FROM runs ORDER BY created_at_utc, run_id"
        )
        .all()
    );
  }

  #taskRunRows(runId?: string): readonly TaskRunRow[] {
    if (runId === undefined) {
      return this.#read(() =>
        this.#database
          .prepare<[], TaskRunRow>(
            "SELECT task_run_id, run_id, task_id, task_content_hash, attempt, state, outcome, error_category, record_json, record_hash FROM task_runs ORDER BY run_id, task_id, attempt, task_run_id"
          )
          .all()
      );
    }
    return this.#read(() =>
      this.#database
        .prepare<[string], TaskRunRow>(
          "SELECT task_run_id, run_id, task_id, task_content_hash, attempt, state, outcome, error_category, record_json, record_hash FROM task_runs WHERE run_id = ? ORDER BY task_id, attempt, task_run_id"
        )
        .all(runId)
    );
  }

  #eventRows(runId?: string): readonly EventRow[] {
    if (runId === undefined) {
      return this.#read(() =>
        this.#database
          .prepare<[], EventRow>(
            "SELECT event_id, run_id, sequence, event_json FROM events ORDER BY run_id, sequence"
          )
          .all()
      );
    }
    return this.#read(() =>
      this.#database
        .prepare<[string], EventRow>(
          "SELECT event_id, run_id, sequence, event_json FROM events WHERE run_id = ? ORDER BY sequence"
        )
        .all(runId)
    );
  }

  #insertQuarantine(
    entityType: QuarantineEntityType,
    entityId: string,
    parentRunId: string | null,
    reason: string,
    originalRecordJson: string | null,
    expectedHash: string | null,
    actualHash: string | null,
    quarantinedBlobPath: string | null
  ): void {
    const detectedAtUtc = this.#options.clock.wallTime();
    const detectionContextJson = canonicalJson({
      source: "store_read_verification",
      entityType,
      entityId,
      reason
    });
    this.#database
      .prepare<
        [string, string, string | null, string, string, string, string | null, string | null, string | null, string | null]
      >(
        "INSERT OR IGNORE INTO quarantine_records (entity_type, entity_id, parent_run_id, detected_at_utc, category, reason, detection_context_json, original_record_json, expected_hash, actual_hash, quarantined_blob_path) VALUES (?, ?, ?, ?, 'storage_corrupt', ?, ?, ?, ?, ?, ?)"
      )
      .run(
        entityType,
        entityId,
        parentRunId,
        detectedAtUtc,
        reason,
        detectionContextJson,
        originalRecordJson,
        expectedHash,
        actualHash,
        quarantinedBlobPath
      );
  }

  async #quarantineRun(row: RunRow, reason: string, actualHash: string): Promise<void> {
    await this.#writeTransaction(() => {
      for (const event of this.#eventRows(row.run_id)) {
        this.#insertQuarantine(
          "event",
          event.event_id,
          event.run_id,
          `parent run quarantined: ${reason}`,
          event.event_json,
          null,
          null,
          null
        );
      }
      for (const task of this.#taskRunRows(row.run_id)) {
        this.#insertQuarantine(
          "task_run",
          task.task_run_id,
          task.run_id,
          `parent run quarantined: ${reason}`,
          task.record_json,
          task.record_hash,
          sha256Text(task.record_json),
          null
        );
      }
      this.#insertQuarantine(
        "run",
        row.run_id,
        row.run_id,
        reason,
        row.record_json,
        row.record_hash,
        actualHash,
        null
      );
      this.#database.prepare<[string]>("DELETE FROM events WHERE run_id = ?").run(row.run_id);
      this.#database.prepare<[string]>("DELETE FROM task_runs WHERE run_id = ?").run(row.run_id);
      this.#database.prepare<[string]>("DELETE FROM runs WHERE run_id = ?").run(row.run_id);
    });
  }

  async #quarantineTaskRun(
    row: TaskRunRow,
    reason: string,
    actualHash: string
  ): Promise<void> {
    await this.#writeTransaction(() => {
      this.#insertQuarantine(
        "task_run",
        row.task_run_id,
        row.run_id,
        reason,
        row.record_json,
        row.record_hash,
        actualHash,
        null
      );
      this.#database
        .prepare<[string]>("DELETE FROM task_runs WHERE task_run_id = ?")
        .run(row.task_run_id);
    });
  }

  async #quarantineEvent(row: EventRow, reason: string): Promise<void> {
    await this.#writeTransaction(() => {
      this.#insertQuarantine(
        "event",
        row.event_id,
        row.run_id,
        reason,
        row.event_json,
        null,
        null,
        null
      );
      this.#database.prepare<[string]>("DELETE FROM events WHERE event_id = ?").run(row.event_id);
    });
  }

  async #verifiedRun(row: RunRow): Promise<RunRecord> {
    const actualHash = sha256Text(row.record_json);
    let record: RunRecord;
    let reason: string | undefined;
    if (!/^[0-9a-f]{64}$/u.test(row.record_hash) || actualHash !== row.record_hash) {
      reason = "run record hash mismatch";
    }
    try {
      record = validateRunRecordJson(row.record_json);
      if (!rowProjectionMatchesRun(row, record)) {
        reason = reason ?? "run projection columns do not match canonical record";
      }
    } catch {
      reason = reason ?? "run record failed bounded canonical schema validation";
      record = undefined as never;
    }
    if (reason !== undefined) {
      await this.#quarantineRun(row, reason, actualHash);
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: run ${row.run_id} failed integrity verification and was moved to quarantine; evidence was preserved; inspect assay doctor`
      );
    }
    return record;
  }

  async #verifiedTaskRun(row: TaskRunRow): Promise<TaskRunRecord> {
    const actualHash = sha256Text(row.record_json);
    let record: TaskRunRecord;
    let reason: string | undefined;
    if (!/^[0-9a-f]{64}$/u.test(row.record_hash) || actualHash !== row.record_hash) {
      reason = "task-run record hash mismatch";
    }
    try {
      record = validateTaskRunRecordJson(row.record_json);
      if (!rowProjectionMatchesTaskRun(row, record)) {
        reason = reason ?? "task-run projection columns do not match canonical record";
      }
    } catch {
      reason = reason ?? "task-run record failed bounded canonical schema validation";
      record = undefined as never;
    }
    if (reason !== undefined) {
      await this.#quarantineTaskRun(row, reason, actualHash);
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: task run ${row.task_run_id} failed integrity verification and was moved to quarantine; evidence was preserved; inspect assay doctor`
      );
    }
    return record;
  }

  async #verifiedEvent(row: EventRow): Promise<StoredEvent> {
    let event: AssayEvent;
    let reason: string | undefined;
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 0) {
      reason = "event sequence is not a non-negative safe integer";
    }
    try {
      event = parseAssayEvent(row.event_json);
      if (
        canonicalJson(event) !== row.event_json ||
        event.run_id !== row.run_id ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.event_id)
      ) {
        reason = reason ?? "event projection or canonical form is inconsistent";
      }
    } catch {
      reason = reason ?? "event failed bounded schema validation";
      event = undefined as never;
    }
    if (reason !== undefined) {
      await this.#quarantineEvent(row, reason);
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: event ${row.event_id} failed integrity verification and was moved to quarantine; evidence was preserved; inspect assay doctor`
      );
    }
    return { eventId: row.event_id, sequence: row.sequence, event };
  }

  #quarantineEntryExists(entityType: QuarantineEntityType, entityId: string): boolean {
    return this.#read(
      () =>
        this.#database
          .prepare<[string, string], { readonly found: number }>(
            "SELECT 1 AS found FROM quarantine_records WHERE entity_type = ? AND entity_id = ? LIMIT 1"
          )
          .get(entityType, entityId) !== undefined
    );
  }

  async #taskRowsReferencing(hash: BlobHash): Promise<readonly TaskRunRow[]> {
    const matching: TaskRunRow[] = [];
    for (const row of this.#taskRunRows()) {
      let record: TaskRunRecord;
      try {
        record = validateTaskRunRecordJson(row.record_json);
      } catch {
        await this.#quarantineTaskRun(
          row,
          "task-run record failed validation while resolving a blob reference",
          sha256Text(row.record_json)
        );
        continue;
      }
      if (record.trajectoryBlob === hash || record.workspaceSnapshot === hash) {
        matching.push(row);
      }
    }
    return matching;
  }

  async #quarantineBlobFailure(error: BlobIntegrityError): Promise<number> {
    const references = await this.#taskRowsReferencing(error.blobHash);
    if (error.missing && references.length === 0 && !this.#quarantineEntryExists("blob", error.blobHash)) {
      return 0;
    }
    const reason = error.missing
      ? "referenced blob is missing"
      : "blob content hash does not match its address";
    let quarantinePath: string | null;
    try {
      quarantinePath = await this.#blobStore.quarantineCorruptObject(
        error.blobHash,
        timestampToken(this.#options.clock.wallTime())
      );
    } catch (cause) {
      if (cause instanceof AssayError) {
        throw cause;
      }
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: corrupt blob ${error.blobHash} was detected but its bytes could not be moved into quarantine; no bytes were served and database references remain intact; inspect filesystem permissions with assay doctor`,
        { cause }
      );
    }
    await this.#writeTransaction(() => {
      this.#insertQuarantine(
        "blob",
        error.blobHash,
        references[0]?.run_id ?? null,
        reason,
        null,
        error.blobHash,
        error.actualHash,
        quarantinePath
      );
      for (const row of references) {
        this.#insertQuarantine(
          "task_run",
          row.task_run_id,
          row.run_id,
          `${reason}: ${error.blobHash}`,
          row.record_json,
          row.record_hash,
          sha256Text(row.record_json),
          null
        );
        this.#database
          .prepare<[string]>("DELETE FROM task_runs WHERE task_run_id = ?")
          .run(row.task_run_id);
      }
    });
    return references.length;
  }

  async #ensureBlobDurable(hash: BlobHash): Promise<void> {
    try {
      await this.#blobStore.fsyncVerified(hash);
    } catch (error) {
      if (!(error instanceof BlobIntegrityError)) {
        if (error instanceof AssayError) {
          throw error;
        }
        throw new AssayError(
          "storage_corrupt",
          `storage_corrupt: blob ${hash} could not be fsynced before row commit; no referencing row committed; inspect filesystem capacity and assay doctor`,
          { cause: error }
        );
      }
      await this.#quarantineBlobFailure(error);
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: blob ${hash} was not durable and hash-valid before row commit; no referencing row committed; inspect assay doctor`
      );
    }
  }

  async appendRun(run: NewRunRecord): Promise<RunId> {
    this.#assertOpen();
    const runId = this.#options.runIdSource.next();
    createRunId(runId);
    const record: RunRecord = { runId, ...run };
    const encoded = canonicalRecord(record);
    validateRunRecordJson(encoded.json);
    invokeFault(this.#options.faultInjector, "before_run_commit");
    try {
      await this.#writeTransaction(() => {
        this.#database
          .prepare<
            [string, string, string, string, string, string, string | null, number, string, string, string, string]
          >(
            "INSERT INTO runs (run_id, created_at_utc, suite_hash, variant, adapter_id, adapter_version, model_id, seed, harness_version, status, record_json, record_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            runId,
            record.createdAtUtc,
            record.suiteHash,
            record.variant,
            record.adapterId,
            record.adapterVersion,
            record.modelId,
            record.seed,
            record.harnessVersion,
            record.status,
            encoded.json,
            encoded.hash
          );
      });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: run id ${runId} already exists; no prior record changed; repair the IdSource`,
          { cause: error }
        );
      }
      throw error;
    }
    invokeFault(this.#options.faultInjector, "after_run_commit");
    return runId;
  }

  async settleRun(
    runId: RunId,
    status: Exclude<RunStatus, "in_progress">
  ): Promise<void> {
    this.#assertOpen();
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new AssayError(
        "internal_invariant",
        `internal_invariant: run ${runId} cannot settle to ${JSON.stringify(status)}; no record changed; use completed, failed, or cancelled`
      );
    }
    const current = await this.getRun(runId);
    if (current.status !== "in_progress") {
      throw new AssayError(
        "internal_invariant",
        `internal_invariant: run ${runId} already settled as ${current.status}; no record changed; append a new run instead of resettling immutable evidence`
      );
    }
    const settled: RunRecord = { ...current, status };
    const encoded = canonicalRecord(settled);
    validateRunRecordJson(encoded.json);
    await this.#writeTransaction(() => {
      const update = this.#database
        .prepare<[string, string, string, string]>(
          "UPDATE runs SET status = ?, record_json = ?, record_hash = ? WHERE run_id = ? AND status = 'in_progress'"
        )
        .run(status, encoded.json, encoded.hash, runId);
      if (update.changes !== 1) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: run ${runId} lost its one-way in_progress settlement race; no completed evidence was overwritten; reopen the run before retrying`
        );
      }
    });
  }

  async appendTaskRun(runId: RunId, input: NewTaskRunRecord): Promise<TaskRunId> {
    this.#assertOpen();
    await this.getRun(runId);

    const existing = this.#read(() =>
      this.#database
        .prepare<[string, string, number], TaskRunRow>(
          "SELECT task_run_id, run_id, task_id, task_content_hash, attempt, state, outcome, error_category, record_json, record_hash FROM task_runs WHERE run_id = ? AND task_id = ? AND attempt = ?"
        )
        .get(runId, input.taskId, input.attempt)
    );
    if (existing !== undefined) {
      const existingRecord = await this.#verifiedTaskRun(existing);
      if (existingRecord.trajectoryBlob !== null) {
        await this.#ensureBlobDurable(existingRecord.trajectoryBlob);
      }
      if (existingRecord.workspaceSnapshot !== null) {
        await this.#ensureBlobDurable(existingRecord.workspaceSnapshot);
      }
      const expected = canonicalJson({
        taskRunId: existingRecord.taskRunId,
        runId,
        ...input
      });
      if (expected !== existing.record_json) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: task run natural key (${runId}, ${input.taskId}, ${input.attempt}) already names different immutable evidence; no row changed; append a new attempt`
        );
      }
      return existingRecord.taskRunId;
    }

    if (input.trajectoryBlob !== null) {
      await this.#ensureBlobDurable(input.trajectoryBlob);
    }
    if (input.workspaceSnapshot !== null) {
      await this.#ensureBlobDurable(input.workspaceSnapshot);
    }

    const taskRunId = this.#options.taskRunIdSource.next();
    createTaskRunId(taskRunId);
    const record: TaskRunRecord = { taskRunId, runId, ...input };
    const encoded = canonicalRecord(record);
    validateTaskRunRecordJson(encoded.json);
    invokeFault(this.#options.faultInjector, "before_task_run_commit");
    try {
      await this.#writeTransaction(() => {
        this.#database
          .prepare<
            [string, string, string, string, number, string, string | null, string | null, string, string]
          >(
            "INSERT INTO task_runs (task_run_id, run_id, task_id, task_content_hash, attempt, state, outcome, error_category, record_json, record_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            taskRunId,
            runId,
            record.taskId,
            record.taskContentHash,
            record.attempt,
            record.state,
            record.outcome,
            record.errorCategory,
            encoded.json,
            encoded.hash
          );
      });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: task-run id or natural key collided for ${taskRunId}; no prior record changed; repair the IdSource or append a new attempt`,
          { cause: error }
        );
      }
      throw error;
    }
    invokeFault(this.#options.faultInjector, "after_task_run_commit");
    return taskRunId;
  }

  async appendEvent(runId: RunId, sequence: number, event: AssayEvent): Promise<string> {
    this.#assertOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new AssayError(
        "invalid_invocation",
        "invalid_invocation: event sequence must be a non-negative safe integer; no event was written; provide the next durable sequence"
      );
    }
    if (event.run_id !== runId) {
      throw new AssayError(
        "internal_invariant",
        `internal_invariant: event run id ${event.run_id} does not match append target ${runId}; no event was written; repair the runner event binding`
      );
    }
    await this.getRun(runId);
    const eventJson = canonicalJson(event);
    parseAssayEvent(eventJson);
    const eventId = ensureEventId(this.#options.eventIdSource.next());
    invokeFault(this.#options.faultInjector, "before_event_commit");
    try {
      await this.#writeTransaction(() => {
        this.#database
          .prepare<[string, string, number, string]>(
            "INSERT INTO events (event_id, run_id, sequence, event_json) VALUES (?, ?, ?, ?)"
          )
          .run(eventId, runId, sequence, eventJson);
      });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new AssayError(
          "internal_invariant",
          `internal_invariant: event id or sequence collided for run ${runId} sequence ${sequence}; no prior event changed; preserve the original event identity`,
          { cause: error }
        );
      }
      throw error;
    }
    invokeFault(this.#options.faultInjector, "after_event_commit");
    return eventId;
  }

  async putBlob(bytes: Uint8Array): Promise<BlobHash> {
    this.#assertOpen();
    try {
      return await this.#blobStore.put(bytes);
    } catch (error) {
      if (error instanceof AssayError) {
        throw error;
      }
      throw new AssayError(
        "storage_corrupt",
        "storage_corrupt: atomic blob persistence failed before a database row referenced it; no dangling reference committed; inspect filesystem capacity and assay doctor",
        { cause: error }
      );
    }
  }

  async getBlob(hash: BlobHash): Promise<Uint8Array> {
    this.#assertOpen();
    createBlobHash(hash);
    try {
      return await this.#blobStore.getVerified(hash);
    } catch (error) {
      if (!(error instanceof BlobIntegrityError)) {
        if (error instanceof AssayError) {
          throw error;
        }
        throw new AssayError(
          "storage_corrupt",
          `storage_corrupt: blob ${hash} could not be verified; no unverified bytes were returned; inspect assay doctor`,
          { cause: error }
        );
      }
      const referenceCount = await this.#quarantineBlobFailure(error);
      if (
        error.missing &&
        referenceCount === 0 &&
        !this.#quarantineEntryExists("blob", hash)
      ) {
        throw new AssayError(
          "invalid_invocation",
          `invalid_invocation: blob ${hash} does not exist; no state changed; verify the content address`
        );
      }
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: blob ${hash} failed content-address verification and was quarantined with every referencing record; evidence was preserved; inspect assay doctor`
      );
    }
  }

  async getRun(id: RunId): Promise<RunRecord> {
    this.#assertOpen();
    createRunId(id);
    const row = this.#read(() =>
      this.#database
        .prepare<[string], RunRow>(
          "SELECT run_id, created_at_utc, suite_hash, variant, adapter_id, adapter_version, model_id, seed, harness_version, status, record_json, record_hash FROM runs WHERE run_id = ?"
        )
        .get(id)
    );
    if (row !== undefined) {
      return await this.#verifiedRun(row);
    }
    if (this.#quarantineEntryExists("run", id)) {
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: run ${id} is quarantined and cannot be served as valid evidence; no state changed; inspect assay doctor`
      );
    }
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: run ${id} does not exist; no state changed; list available runs`
    );
  }

  async getTaskRun(id: TaskRunId): Promise<TaskRunRecord> {
    this.#assertOpen();
    createTaskRunId(id);
    const row = this.#read(() =>
      this.#database
        .prepare<[string], TaskRunRow>(
          "SELECT task_run_id, run_id, task_id, task_content_hash, attempt, state, outcome, error_category, record_json, record_hash FROM task_runs WHERE task_run_id = ?"
        )
        .get(id)
    );
    if (row !== undefined) {
      return await this.#verifiedTaskRun(row);
    }
    if (this.#quarantineEntryExists("task_run", id)) {
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: task run ${id} is quarantined and cannot be served as valid evidence; no state changed; inspect assay doctor`
      );
    }
    throw new AssayError(
      "invalid_invocation",
      `invalid_invocation: task run ${id} does not exist; no state changed; list task runs for its parent run`
    );
  }

  async *listRuns(query: RunQuery): AsyncIterable<RunSummary> {
    this.#assertOpen();
    const limit = query.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)) {
      throw new AssayError(
        "invalid_invocation",
        "invalid_invocation: run query limit must be an integer from 1 through 100000; no state changed; use a bounded limit"
      );
    }
    let emitted = 0;
    for (const row of this.#runRows()) {
      const record = await this.#verifiedRun(row);
      if (
        (query.suiteHash !== undefined && record.suiteHash !== query.suiteHash) ||
        (query.variant !== undefined && record.variant !== query.variant) ||
        (query.adapterId !== undefined && record.adapterId !== query.adapterId) ||
        (query.status !== undefined && record.status !== query.status)
      ) {
        continue;
      }
      yield record;
      emitted += 1;
      if (limit !== undefined && emitted >= limit) {
        return;
      }
    }
  }

  async *listTaskRuns(runId: RunId): AsyncIterable<TaskRunRecord> {
    this.#assertOpen();
    createRunId(runId);
    for (const row of this.#taskRunRows(runId)) {
      yield await this.#verifiedTaskRun(row);
    }
  }

  async listEvents(runId: RunId): Promise<readonly StoredEvent[]> {
    this.#assertOpen();
    createRunId(runId);
    const events: StoredEvent[] = [];
    for (const row of this.#eventRows(runId)) {
      events.push(await this.#verifiedEvent(row));
    }
    return events;
  }

  async listQuarantined(): Promise<readonly QuarantineRecord[]> {
    this.#assertOpen();
    return this.#read(() =>
      this.#database
        .prepare<[], QuarantineRow>(
          "SELECT quarantine_id, entity_type, entity_id, parent_run_id, detected_at_utc, category, reason, detection_context_json, original_record_json, expected_hash, actual_hash, quarantined_blob_path FROM quarantine_records ORDER BY quarantine_id"
        )
        .all()
        .map(quarantineFromRow)
    );
  }

  async verifyIntegrity(): Promise<IntegrityReport> {
    this.#assertOpen();
    const check = this.#read(() => quickCheck(this.#database));
    if (check !== "ok") {
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: SQLite quick_check returned ${JSON.stringify(check)}; no record was served; close the store and recover from its quarantined copy`
      );
    }
    const runs = this.#runRows();
    const taskRuns = this.#taskRunRows();
    const events = this.#eventRows();
    for (const row of runs) {
      await this.#verifiedRun(row);
    }
    const blobHashes = new Set<BlobHash>();
    for (const row of taskRuns) {
      const record = await this.#verifiedTaskRun(row);
      if (record.trajectoryBlob !== null) {
        blobHashes.add(record.trajectoryBlob);
      }
      if (record.workspaceSnapshot !== null) {
        blobHashes.add(record.workspaceSnapshot);
      }
    }
    for (const row of events) {
      await this.#verifiedEvent(row);
    }
    for (const hash of blobHashes) {
      await this.getBlob(hash);
    }
    return {
      quickCheck: "ok",
      checkedRuns: runs.length,
      checkedTaskRuns: taskRuns.length,
      checkedEvents: events.length,
      checkedBlobs: blobHashes.size,
      danglingBlobReferences: []
    };
  }

  async diagnostics(): Promise<StoreDiagnostics> {
    this.#assertOpen();
    return {
      databasePath: this.#paths.databasePath,
      objectsPath: this.#paths.objectsPath,
      schemaVersion: this.#schemaVersion,
      journalMode: this.#journalMode,
      quickCheck: this.#read(() => quickCheck(this.#database))
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    let closeError: unknown;
    try {
      if (this.#database.open) {
        this.#database.close();
      }
    } catch (error) {
      closeError = error;
    }
    let releaseError: unknown;
    try {
      await this.#writerLock.release();
    } catch (error) {
      releaseError = error;
    }
    if (closeError !== undefined || releaseError !== undefined) {
      throw new AssayError(
        "storage_corrupt",
        "storage_corrupt: SQLite close or writer-lock release failed; committed records remain governed by WAL recovery; reopen and run assay doctor",
        { cause: closeError ?? releaseError }
      );
    }
  }
}

export async function openRunStore(options: RunStoreOptions): Promise<RunStore> {
  let paths: StorePaths;
  try {
    paths = await resolveStorePaths(options.projectRoot, options.storePath);
  } catch (error) {
    if (error instanceof AssayError) {
      throw error;
    }
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: project store paths beneath ${JSON.stringify(options.projectRoot)} could not be prepared securely; no database record changed; inspect filesystem permissions with assay doctor`,
      { cause: error }
    );
  }
  const writerLock = await acquireWriterLock(
    paths,
    options.processId,
    options.clock,
    options.lockPolicy
  );
  let database: Database.Database | undefined;
  try {
    await validateExistingDatabasePath(paths.databasePath);
    await new ContentAddressedBlobStore(
      paths,
      options.processId,
      options.faultInjector
    ).cleanInterruptedTemporaryFiles();
    try {
      database = new Database(paths.databasePath, { timeout: 0 });
      await chmod(paths.databasePath, 0o600);
      const check = quickCheck(database);
      if (check !== "ok") {
        throw new AssayError(
          "storage_corrupt",
          `storage_corrupt: SQLite quick_check returned ${JSON.stringify(check)}; the whole database will be quarantined; restore from a known-good copy`
        );
      }
      const tablesBeforeConfiguration = userTableNames(database);
      let schemaVersion: number;
      let journalMode: string;
      if (tablesBeforeConfiguration.size === 0) {
        journalMode = configureDatabase(database);
        schemaVersion = initializeOrValidateSchema(database, tablesBeforeConfiguration);
      } else {
        schemaVersion = initializeOrValidateSchema(database, tablesBeforeConfiguration);
        journalMode = configureDatabase(database);
      }
      const store = new SqliteRunStore(
        database,
        paths,
        writerLock,
        options,
        journalMode,
        schemaVersion
      );
      return store;
    } catch (error) {
      if (error instanceof AssayError && error.category === "storage_migration_required") {
        database?.close();
        await writerLock.release();
        throw error;
      }
      database?.close();
      await quarantineDatabaseFiles(paths, options.clock.wallTime());
      await writerLock.release();
      if (error instanceof AssayError && error.category === "storage_corrupt") {
        throw error;
      }
      throw new AssayError(
        "storage_corrupt",
        `storage_corrupt: SQLite store at ${JSON.stringify(paths.databasePath)} could not be opened or verified and was quarantined; evidence was preserved; inspect assay doctor`,
        { cause: error }
      );
    }
  } catch (error) {
    if (database?.open === true) {
      database.close();
    }
    await writerLock.release();
    if (error instanceof AssayError) {
      throw error;
    }
    throw new AssayError(
      "storage_corrupt",
      `storage_corrupt: store setup failed before a verified handle was returned for ${JSON.stringify(paths.databasePath)}; no unverified record was served; inspect assay doctor`,
      { cause: error }
    );
  }
}

export { sha256Blob };
