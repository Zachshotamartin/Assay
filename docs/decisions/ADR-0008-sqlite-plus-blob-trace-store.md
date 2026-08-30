# ADR-0008: SQLite Plus Content-Addressed Blob Trace Store

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TRACE-001 through FR-TRACE-010,
  FR-RUN-009, FR-RUN-011, NFR-COST-006, NFR-PRIV-001

## Context

Every run must persist durably (FR-TRACE-001), reruns append rather than
mutate (FR-RUN-009), the comparison engine needs indexed queries across
runs, and the viewer must render a 200-turn trajectory in under one second
p95 from local data (NFR-COST-006). The store also inherits the ADR-0002
boundary: local-first, no operated service. Trajectory JSONL and tool
output are large and immutable; run metadata is small and relational. One
storage shape does not fit both, so the split must be fixed before R1's
store core can be planned.

## Decision

A local-first two-part store: one SQLite database per project
(`.assay/assay.db`, WAL mode) for runs, tasks, turns, metrics, and
comparisons, plus a content-addressed blob directory
(`.assay/objects/<sha256[0..2]>/<sha256>`) for trajectory JSONL, tool
output, and fixture manifests. The database holds blob-hash references to
the immutable payloads; deduplication falls out of content addressing.

Schema evolution is forward-only numbered migrations: each migration has
a monotonically increasing number and moves a database forward only; no
down-migration is written or supported. `assay db migrate` is explicit
and never runs implicitly on read; a store whose schema version is behind
the harness fails with `storage_migration_required`, never a silent
upgrade. CI keeps old-version fixture databases — one frozen file per
historical schema version — and every migration must carry each fixture
to the current version with row-level assertions on the migrated content.
Corruption is detected and quarantined, never dropped (FR-TRACE-009).

## Alternatives Considered

- Postgres: rejected because requiring users to run a database server
  contradicts the local-first CI-gate positioning; a gate that needs
  operational infrastructure before its first run loses zero-setup
  adoption.
- Flat JSON files only: rejected because comparison and viewer queries
  (list runs by suite hash, pair runs by task content hash, aggregate
  pass rates) need indexes; scanning a JSON directory on every comparison
  fails NFR-COST-006 and grows linearly worse.
- DuckDB: rejected because its concurrent-writer story is weaker than
  SQLite's WAL mode for parallel task runs appending from a worker pool;
  DuckDB is built for analytical reads, not many small concurrent
  transactional appends.
- Blobs inside SQLite as BLOB columns: rejected because multi-megabyte
  trajectory payloads bloat the database file, slow backup and migration
  fixtures, and forgo free deduplication of identical content.

## Consequences

`assay export` can produce a self-contained bundle by copying one database
plus referenced objects (FR-TRACE-007), and deletion removes exactly the
selected runs plus newly unreferenced blobs. Crash recovery reduces to
WAL replay plus a reaper pass (FR-RUN-011).

The costs: forward-only means a downgrade path never exists — a user who
rolls back the harness cannot open a migrated store, by design. The
old-version fixture suite is cheap while only schema v1 exists, but once
a v2 schema ships, every subsequent migration must be tested against both
v1 and v2 fixtures; that growing burden is accepted and re-costed at the
first v2 migration (owned by R10, FR-TRACE-006). Blob garbage collection
needs a reference-counting pass in `assay gc`; getting it wrong deletes
evidence, so it ships fail-safe (never delete on ambiguity).
