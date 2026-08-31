import type {
  AssayEvent,
  BlobHash,
  Clock,
  ContentHash,
  IdSource,
  NewRunRecord,
  NewTaskRunRecord,
  RunId,
  RunRecord,
  RunStatus,
  TaskRunId,
  TaskRunRecord,
  VariantName
} from "@assay/contracts";

export type { NewRunRecord, NewTaskRunRecord, RunRecord, TaskRunRecord } from "@assay/contracts";

export const STORE_SCHEMA_VERSION = 1 as const;
export const STORE_CREATED_BY_VERSION = "0.0.0" as const;
export const MAX_RECORD_JSON_BYTES = 4_194_304;
export const MAX_LOCK_FILE_BYTES = 4_096;
export const MAX_STORE_CONFIG_BYTES = 4_096;

export type StoreFaultMarker =
  | "before_blob_rename"
  | "after_blob_rename"
  | "before_run_commit"
  | "after_run_commit"
  | "before_task_run_commit"
  | "after_task_run_commit"
  | "before_event_commit"
  | "after_event_commit";

export interface StoreLockPolicy {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export interface RunStoreOptions {
  readonly projectRoot: string;
  readonly storePath?: string;
  readonly clock: Clock;
  readonly processId: number;
  readonly runIdSource: IdSource<RunId>;
  readonly taskRunIdSource: IdSource<TaskRunId>;
  readonly eventIdSource: IdSource<string>;
  readonly lockPolicy?: StoreLockPolicy;
  readonly faultInjector?: (marker: StoreFaultMarker) => void;
}

export interface RunQuery {
  readonly suiteContentHash?: ContentHash;
  readonly variant?: VariantName;
  readonly adapterId?: string;
  readonly status?: RunStatus;
  readonly limit?: number;
}

export type RunSummary = RunRecord;

export interface StoredEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly event: AssayEvent;
}

export interface TaskRunEventInput {
  readonly sequence: number;
  readonly event: AssayEvent;
}

export type QuarantineEntityType = "run" | "task_run" | "event" | "blob";

export interface QuarantineRecord {
  readonly quarantineId: number;
  readonly entityType: QuarantineEntityType;
  readonly entityId: string;
  readonly parentRunId: RunId | null;
  readonly detectedAtUtc: string;
  readonly category: "storage_corrupt";
  readonly reason: string;
  readonly detectionContextJson: string;
  readonly originalRecordJson: string | null;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;
  readonly quarantinedBlobPath: string | null;
}

export interface StoreDiagnostics {
  readonly databasePath: string;
  readonly objectsPath: string;
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly quickCheck: string;
}

export interface DanglingBlobReference {
  readonly taskRunId: TaskRunId;
  readonly blobHash: BlobHash;
  readonly field: "trajectoryBlob" | "workspaceSnapshot";
}

export interface IntegrityReport {
  readonly quickCheck: "ok";
  readonly checkedRuns: number;
  readonly checkedTaskRuns: number;
  readonly checkedEvents: number;
  readonly checkedBlobs: number;
  readonly danglingBlobReferences: readonly DanglingBlobReference[];
}

export interface RunStore {
  appendRun(run: NewRunRecord): Promise<RunId>;
  settleRun(runId: RunId, status: Exclude<RunStatus, "in_progress">): Promise<void>;
  appendTaskRun(runId: RunId, record: NewTaskRunRecord): Promise<TaskRunId>;
  appendTaskRunWithEvents(
    runId: RunId,
    record: NewTaskRunRecord,
    events: readonly TaskRunEventInput[]
  ): Promise<TaskRunId>;
  appendEvent(runId: RunId, sequence: number, event: AssayEvent): Promise<string>;
  putBlob(bytes: Uint8Array): Promise<BlobHash>;
  getBlob(hash: BlobHash): Promise<Uint8Array>;
  getRun(id: RunId): Promise<RunRecord>;
  getTaskRun(id: TaskRunId): Promise<TaskRunRecord>;
  listRuns(query: RunQuery): AsyncIterable<RunSummary>;
  listTaskRuns(runId: RunId): AsyncIterable<TaskRunRecord>;
  listEvents(runId: RunId): Promise<readonly StoredEvent[]>;
  listQuarantined(): Promise<readonly QuarantineRecord[]>;
  verifyIntegrity(): Promise<IntegrityReport>;
  diagnostics(): Promise<StoreDiagnostics>;
  close(): Promise<void>;
}
