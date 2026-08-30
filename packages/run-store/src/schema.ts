import { STORE_SCHEMA_VERSION } from "./types.js";

export const SCHEMA_V1_SQL = `
CREATE TABLE schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  created_at_utc TEXT NOT NULL,
  suite_hash TEXT NOT NULL,
  variant TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  model_id TEXT,
  seed INTEGER NOT NULL,
  harness_version TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE task_runs (
  task_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  task_content_hash TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  error_category TEXT,
  record_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  UNIQUE (run_id, task_id, attempt)
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE quarantine_records (
  quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run','task_run','event','blob')),
  entity_id TEXT NOT NULL,
  parent_run_id TEXT,
  detected_at_utc TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category = 'storage_corrupt'),
  reason TEXT NOT NULL,
  detection_context_json TEXT NOT NULL,
  original_record_json TEXT,
  expected_hash TEXT,
  actual_hash TEXT,
  quarantined_blob_path TEXT,
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX idx_task_runs_run_id ON task_runs (run_id, task_id, attempt, task_run_id);
CREATE INDEX idx_events_run_id ON events (run_id, sequence);
CREATE INDEX idx_quarantine_parent ON quarantine_records (parent_run_id, quarantine_id);

INSERT INTO schema_meta (version) VALUES (${STORE_SCHEMA_VERSION});
PRAGMA user_version = ${STORE_SCHEMA_VERSION};
`;
