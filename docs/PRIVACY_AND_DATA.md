# Assay: Privacy and Data Handling

Status of every behavior in this document: **planned**. R0 and R1 have
branch-local code and local evidence, but neither gate is accepted. R1 uses
only the deterministic simulated adapter and supports no real agent or
provider. Each section names the requirement that owns it and the build gate
whose acceptance evidence proves it.

The governing principle (NFR-PRIV-001): all data is local by default. The
only egress is an explicit provider call the user configured. There is no
telemetry, no update check, no crash reporting, and no analytics endpoint
in 1.0 (NFR-PRIV-006).

Last revised: 2026-08-30.

## 1. Data Inventory

A trace is everything Assay records about one run. The inventory below is
field-level and normative: a captured field not listed here is a
documentation defect. Sensitivity classes:

- **operational** — harness bookkeeping; no user content
- **project** — derived from the user's repository, fixtures, or tasks;
  may contain proprietary source and business logic
- **conversational** — model-visible text; may contain anything the agent
  or provider produced
- **secret-bearing** — surfaces where credentials realistically appear;
  always pass ADR-0010 redaction before persistence (all classes pass
  redaction; these are the classes redaction exists for)

### 1.1 Run and task records (SQLite, per ADR-0008)

| Field group | Contents | Class |
| --- | --- | --- |
| Run identity | Run id, suite content hash, task content hashes, variant, seeds, harness version, timestamps | operational |
| Adapter identity | Adapter id, version, contract version, conformance tier | operational |
| Model identity | Provider, model id per model request | operational |
| Lifecycle | State-machine transitions, terminal state, error category | operational |
| Task outcome | pass/fail/error, assertion verdicts, budget verdicts | operational |
| Usage | Prompt/completion token counts, reported and derived dollar cost, reconciliation status | operational |
| Timings | Provider latency, tool latency, harness overhead, wall clock | operational |
| Statistics | Pass rates, intervals, test results, bootstrap seeds | operational |

### 1.2 Trajectory blobs (content-addressed, per ADR-0008)

| Field group | Contents | Class |
| --- | --- | --- |
| Model requests | Full prompt text sent per request, including the task prompt and agent-assembled context | project + conversational, secret-bearing |
| Model responses | Full response text and structured tool-call requests | conversational, secret-bearing |
| Tool calls | Tool name, semantic class, full arguments, full results | project + conversational, secret-bearing |
| File snapshots | Content-addressed workspace snapshot after agent exit: file paths and file contents | project, secret-bearing |
| Fixture manifest | Fixture archive hash and entry listing (paths, sizes, hashes) | project |
| Adapter stderr | Bounded, truncated diagnostic stream | conversational, secret-bearing |
| Truncation markers | Explicit markers on partial trajectories (FR-TRAJ-009) | operational |

### 1.3 Environment and diagnostics

| Field group | Contents | Class |
| --- | --- | --- |
| Environment allowlist snapshot | Names and values of only the task-declared variables that entered the sandbox (FR-SAND-004); harness host environment is never captured wholesale | project, secret-bearing |
| Diagnostics | Error context, stack traces, doctor output | operational, secret-bearing |
| Judge records | Rubric version, judge model identity, k-vote distribution, agreement statistics, delimited judge inputs | conversational, secret-bearing |
| Calibration data | Human-labeled trajectory excerpts and labels | project + conversational |

### 1.4 Comparison and report records

| Field group | Contents | Class |
| --- | --- | --- |
| Comparison inputs | Baseline and candidate run ids, task content hashes, comparison configuration | operational |
| Statistical results | Per-task deltas, intervals, raw and BH-adjusted p-values, bootstrap seed, minimum detectable effect | operational |
| Wording-contract output | The emitted result phrase per task and per suite | operational |
| Report text | Rendered markdown/JSON reports, including escaped task titles | project |

Comparison records embed no trajectory content; they reference runs by
id, so a shared report leaks task titles and statistics but not prompts,
responses, or snapshots.

Seeds, clocks, and pricing-catalog versions are recorded for
reproducibility and are operational. Nothing in any class is exempt from
capture-boundary redaction (NFR-PRIV-002).

## 2. What Leaves the Machine, and for Which Destination

### 2.1 What never leaves the machine

The following never leave the machine under any configuration, in any
release of the 1.0 line:

- The trace store itself: the SQLite database and the blob directory
- Workspace snapshots and fixture content, except inside a bundle the
  user explicitly exports and then explicitly shares
- BYOK credentials, which exist only in harness process memory at spawn
  time (NFR-SEC-004) and are never written anywhere by Assay
- Calibration sets and their human labels
- Harness configuration, environment, and diagnostics
- Any usage, feature, error, or version telemetry: none exists
  (NFR-PRIV-006)

### 2.2 Per-destination egress

Everything not listed in the table below never leaves the machine
(NFR-PRIV-001). The per-provider egress documentation is itself a
requirement with gate evidence (NFR-PRIV-005, gate R3): the planned
captured-request test suite asserts that serialized outbound requests
contain exactly the described content and nothing else.

| Destination | What is sent | When | What is never sent |
| --- | --- | --- | --- |
| Subject model provider (BYOK) | The task prompt and the agent-visible context: fixture content the agent reads, tool results, and conversation history the adapter assembles | Only during a run against a real provider; never in required CI (NFR-COST-001) | The trace store, other tasks' content, harness configuration, host environment, credentials for any other provider |
| Judge model provider (BYOK) | The checked-in rubric plus delimited, provenance-labeled, isolation-transformed trajectory excerpts selected per rubric (FR-JUDGE-006) | Only when a task declares a judge assertion | Raw undelimited trajectories, the workspace snapshot, calibration labels, credentials |
| GitHub (Action) | Delta tables, PR comment text with all task-derived strings escaped, status-check conclusions, and configured artifacts (§7) | Only in CI with the Action configured | Provider credentials (FR-CI-005), unredacted trajectory content by default |
| Anywhere else | Nothing | Never | Everything: no telemetry, no usage analytics, no version pings (NFR-PRIV-006) |

Simulated and Robin-synthetic runs contact no provider at all; their
egress row is empty and their cost is recorded as `source: synthetic`.

Confidentiality after release to a provider depends on that provider's
terms and retention behavior. Assay documents this honestly and cannot
retract content once sent; see §6 and §8.

## 3. Secret Detection and Redaction (ADR-0010)

Redaction happens at the capture boundary: before any byte is persisted
or leaves the harness process. Post-hoc scrubbing of stored traces was
rejected because it leaves a window where secrets exist on disk.

### 3.1 Ruleset classes

The versioned pattern ruleset matches, at minimum:

- Provider API key shapes for every provider Assay ships a client for
- PEM-encoded private key and certificate blocks
- JWTs (three dot-separated base64url segments with a decodable header)
- Cloud credential formats: AWS access key id and secret key pairs, GCP
  service-account JSON markers, Azure connection strings
- URL userinfo components (`scheme://user:password@host`)

### 3.2 Entropy scanner parameters

The Shannon-entropy scanner supplements the ruleset for unknown formats:

- Candidate unit: contiguous tokens of length ≥ 20 characters drawn from
  base64, base64url, or hexadecimal alphabets
- Threshold: normalized Shannon entropy ≥ 4.0 bits per character for
  base64-class tokens and ≥ 3.0 bits per character for hex-class tokens
- Context suppression: tokens that are known content hashes recorded by
  Assay itself (blob addresses, fixture hashes) are exempted by exact
  match against the run's own hash set, never by pattern
- Action: matched spans are replaced by `[REDACTED:<class>:<len>]`; the
  replacement preserves length metadata but never any prefix or suffix of
  the original bytes

### 3.3 Application points

The ruleset and scanner apply to every one of these surfaces, with no
exempt path:

- Every adapter event before it is buffered for persistence
- Every tool output and adapter stderr chunk
- The environment allowlist snapshot
- Every diagnostic, error message, and doctor report
- Every export and diagnostics bundle, which re-scan with the current
  ruleset even though their contents were redacted at capture (§5)

### 3.4 Capture pipeline ordering

Redaction is a fixed stage in the capture pipeline, with an ordered
contract per record:

1. The raw record arrives from its boundary (adapter frame, tool output
   chunk, environment snapshot, or diagnostic) and is size-bounded.
2. The record is decoded to text where a documented text encoding
   applies; undecodable binary regions are scanned bytewise against the
   ruleset's binary-capable patterns.
3. The pattern ruleset runs first, then the entropy scanner runs over the
   remaining text; replacements from both are merged without overlap.
4. The redacted record, the ruleset version, and per-record match counts
   (counts only, never matched content) are handed to persistence.
5. Only the redacted form is ever buffered for the store, the report
   renderer, the viewer, or a bundle; the raw form is dropped from memory
   when the record completes the stage.

There is no configuration flag that disables redaction, samples it, or
exempts a surface; `assay redact-check <file>` runs the same engine
standalone so users can test rules against their own material.

### 3.5 Fail-closed semantics

If redaction cannot complete for a record — engine fault, resource
exhaustion, or undecodable input — the record is not persisted, the run
fails as an infrastructure error with the stable `redaction_failed`
category, and the report says so. Assay never stores an unredacted record
on the theory that a partial scan probably caught everything.

### 3.6 Evidence and versioning

- Planned evidence (gates R4 and R10, NFR-SEC-001 / NFR-PRIV-002): the
  planted-credential corpus in `fixtures/secrets` — raw, split across
  frames, base64-encoded, URL-embedded, inside tool output, and inside
  trajectory arguments — with scans asserting zero canaries across
  events, blobs, logs, reports, and bundles
- The ruleset is versioned (`redaction-ruleset/N`); every stored record
  carries the ruleset version that redacted it
- Update policy: rule additions ship in minor releases; a rule removal or
  weakening requires an ADR. Stored traces are not retroactively
  re-scanned (rejected per ADR-0010), but export always applies the
  current ruleset, so bundles benefit from every rule added since capture

## 4. Retention

Default: keep everything, locally, forever (FR-TRACE-010). A local store
on the user's own disk with no egress does not expire evidence by
surprise, because stored runs are the baselines CI gates compare against.

Retention is configurable in `assay.config.yaml`:

- `retention.max_age`: delete run records older than a duration
- `retention.max_runs`: keep at most N most-recent runs per suite/variant
- `retention.protect_baselines`: never auto-delete a run referenced as a
  CI baseline (default true; disabling it is an explicit choice)

Per-class rules:

| Data class | Default retention | Configurable |
| --- | --- | --- |
| Run and task records | Forever | Yes, by age or count |
| Trajectory blobs | Forever, refcounted | Follows owning runs |
| Quarantined records | Forever; excluded from queries, preserved as evidence (FR-TRACE-009) | Deletable only by explicit `assay delete` |
| Diagnostics | Forever | Yes; may be shorter than run records |
| Calibration data | Forever; deleting it invalidates judge gating (FR-JUDGE-004) | Explicit delete only |

Automatic retention deletion uses the same refcounted machinery as §6 and
appears in the run log as an auditable event. Planned evidence (gate
R10): retention-policy tests covering age, count, and baseline
protection.

## 5. Export

`assay export <run...>` produces a self-contained redacted bundle
(FR-TRACE-007), designed so a recipient can inspect and compare runs
without the originating machine.

Bundle format (`assay-bundle/1`):

- A deterministic tar archive compressed with zstd
- `manifest.json`: bundle format version, harness version, ruleset
  version applied, run ids, and a per-file SHA-256 listing
- Run and task records serialized as canonical JSON
- Referenced trajectory and snapshot blobs under their content addresses
- Fixture manifests (hashes and entry listings); fixture content itself
  is included only with the explicit `--include-fixtures` flag

Before writing anything, export prints an enumerated contents preview —
every record, blob, and file that will be included, with sizes and
classes from §1 — and requires confirmation (or an explicit `--yes`)
(NFR-PRIV-004 semantics applied to export). Export re-runs redaction with
the current ruleset over every included byte; a redaction failure aborts
the bundle with `redaction_failed` and writes nothing.

Planned evidence (gate R10): `export.enumeration` golden test,
round-trip import inspection test, and the planted-corpus scan over
produced bundles.

## 6. Deletion

`assay delete <run...>` removes exactly the selected runs and nothing
else. The deletion algorithm, in order:

1. Resolve every named run id; an unknown id aborts the whole command
   with `invalid_invocation` before anything is deleted.
2. Compute the owned-blob set: for each blob referenced by a selected
   run, count references from surviving runs; blobs with zero surviving
   references are marked for removal, all others are retained.
3. If any selected run is referenced as a CI baseline, require `--force`
   and print which comparisons the deletion will invalidate.
4. With `--dry-run`, print the full inventory — records to delete, blobs
   to free with sizes, blobs retained and why — and stop with no change.
5. Delete run and task records and blob reference rows in one
   transaction; then remove the marked blob files; a crash between the
   two steps leaves orphaned blob files that `assay gc` removes on next
   start, never dangling references.
6. Record a deletion event (run ids and counts only, no content) in the
   store's audit log.

Properties this guarantees:

- Exact scope: no record or blob outside the selected runs is touched
- Shared content is safe: a blob referenced by a surviving run survives
- The operation is inspectable before it is destructive (`--dry-run`)

What deletion cannot do, stated honestly:

- It cannot remove copies held by a provider. Content sent to a subject
  or judge provider during a run is governed by that provider's retention
  terms from the moment it was sent. Assay's deletion is deletion of the
  local evidence, not a recall of prior egress.
- It cannot recall an exported bundle already shared with someone else.
- It does not overwrite freed disk sectors; secure erasure of underlying
  storage is the operating system's and hardware's domain.

Planned evidence (gate R10, FR-TRACE-007): exact-scope deletion test,
shared-blob refcount test (two runs sharing one blob; deleting one keeps
the blob, deleting both removes it), and dry-run inventory golden test.

## 7. CI Data Handling

When the GitHub Action runs (gate R8):

- The Action stores as workflow artifacts: the comparison report (JSON
  and markdown delta tables) and the run summary. These contain aggregate
  statistics, task ids and titles (escaped), verdicts, intervals, and
  usage totals — not trajectory blobs.
- Full trace bundles are uploaded only if the workflow opts in via
  `upload-traces: true`; the uploaded bundle is produced by the same §5
  export path, redacted and enumerated in the workflow log.
- Artifact retention follows the repository's GitHub artifact settings
  (GitHub's default is 90 days); the Action documents this and exposes a
  `retention-days` input passed through to the upload step.
- PR comments contain the delta table only; task-derived text is escaped
  per THREAT_MODEL.md §7.10. Comments persist as long as the PR does and
  are governed by GitHub's data handling, not Assay's.
- Fork PRs run zero-credential (FR-CI-007), so fork CI data contains only
  simulated-subject results with zero provider egress.

Planned evidence (gate R8): the Action integration test inspects produced
artifacts for class compliance, and the log-canary scan covers the
upload path.

## 8. Shared Trace Bundles: Data-Subject Stance

A trajectory is a recording of an agent working in a repository. It
therefore embeds repository content: source excerpts in prompts, file
contents in tool results and snapshots, commit messages, paths, and any
personal data the repository itself contained. Redaction removes
credential-shaped material; it does not and cannot classify proprietary
code, personal names in comments, or business data as removable.

The stance, stated plainly:

- Sharing a bundle shares that content. Whoever can read the bundle can
  read every file snapshot and prompt inside it.
- Assay's warning surface is the §5 enumerated preview plus an explicit
  notice printed on every export: the bundle embeds repository content
  and tool output, and redaction covers secrets, not confidentiality.
- Anyone with data-subject obligations for repository contents (personal
  data in fixtures, third-party code under restrictive terms) holds those
  obligations for bundles derived from them; Assay gives them the
  enumeration needed to review before sharing, and `assay delete` for the
  local copies afterward.
- The same applies to provider egress: content in prompts sent to a
  provider was disclosed to that provider (§2, §6).

## 9. Explicit Deferrals

Each deferral is recorded in OPEN_QUESTIONS.md with a fail-closed default
and a reopen trigger; none may be claimed as an existing protection.

- Encryption at rest for `.assay/`: deferred. Default posture is the OS
  account boundary plus the honest warning in THREAT_MODEL.md §10.
  Reopen trigger: multi-user machines or shared stores entering scope.
- Org policy packs (centrally managed egress, retention, and export
  policy for teams): deferred. Default posture is per-project
  configuration only. Reopen trigger: the first team-distribution
  requirement with a policy-enforcement need.
- Selective field-level export filters (excluding snapshot classes from a
  bundle): deferred. Default posture is all-or-nothing per run with
  `--include-fixtures` as the only content toggle. Reopen trigger:
  demonstrated need in shared-bundle review workflows.

## 10. Requirements Traced

| Requirement | Section(s) |
| --- | --- |
| NFR-PRIV-001 (local by default; only explicit provider egress) | 2 |
| NFR-PRIV-002 (traces redacted before persistence) | 3 |
| NFR-PRIV-003 (export/deletion/retention per this document) | 4, 5, 6 |
| NFR-PRIV-004 (bundles enumerate contents and pass redaction) | 3.3, 5 |
| NFR-PRIV-005 (per-provider egress documentation complete) | 2 |
| NFR-PRIV-006 (no telemetry in 1.0) | 2 |
| NFR-SEC-001 (no secret in any persisted or emitted surface) | 3 |
| NFR-SEC-004 (spawn-time credential resolution, never persisted) | 1.3, 3 |
| FR-TRACE-007 (self-contained redacted export; exact-scope deletion) | 5, 6 |
| FR-TRACE-009 (quarantine preserved, never silently dropped) | 4 |
| FR-TRACE-010 (configurable retention, keep-local default) | 4 |
| FR-SAND-004 (constructed sandbox environment) | 1.3 |
| FR-JUDGE-006 (delimited, transformed judge egress) | 2 |
| FR-CI-005 / FR-CI-007 (CI credential and fork handling) | 7 |
