# Assay Architecture

Document status: normative architecture specification. R0 and R1 are
accepted; the remaining architecture is planned. Last revised: 2026-08-30.

> Assay is under implementation. Gates R0 and R1 are accepted with repository
> governance, task-format, deterministic runner, assertion, store-core, and
> cross-platform CI evidence. Gates R2 through R10 remain planned. No sandbox,
> real-provider, trajectory, budget, statistical, judge, Action, viewer, or
> packaged-release gate is accepted.

This document controls component boundaries and interfaces. It is subordinate
to accepted ADRs, to PRODUCT_REQUIREMENTS.md for user-visible semantics, to
METHODOLOGY.md for statistical definitions and wording, and to BUILD_PLAN.md
for implementation order, per the conflict-precedence rules in docs/README.md.

Companion documents:

- [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) — requirements and
  acceptance semantics (FR/NFR register).
- [METHODOLOGY.md](./METHODOLOGY.md) — statistical methods, wording contract,
  judge calibration rules.
- [BUILD_PLAN.md](./BUILD_PLAN.md) — gates R0–R10, tickets, evidence.
- [TASK_FORMAT.md](./TASK_FORMAT.md) — YAML task and suite schema.
- [AGENT_COMPATIBILITY.md](./AGENT_COMPATIBILITY.md) — `assay-adapter/1`
  conformance details.
- [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md) — test, evidence, and
  release mechanics.
- [THREAT_MODEL.md](./THREAT_MODEL.md) — security claims and escape-test
  evidence.
- [PRIVACY_AND_DATA.md](./PRIVACY_AND_DATA.md) — data locality, retention,
  export, deletion.
- [LANDSCAPE.md](./LANDSCAPE.md) — descriptive competitive context.
- [decisions/](./decisions/) — ADR-0001 through ADR-0015.

## 1. Architecture objective and constraints

Assay is a CI regression gate for coding and tool-using agents. It scores
trajectories, not just final answers; it enforces cost and latency budgets as
blocking checks; and it treats stochastic comparison as a statistics problem.
The architecture exists to make one journey coherent:

1. A team declares tasks and suites in reviewable YAML.
2. `assay run` executes the suite n times per task per variant inside
   dedicated sandboxes against an agent reached only through a subprocess
   adapter contract.
3. Every model request, tool call, token count, and dollar is captured into a
   canonical, redacted trajectory record and a local store.
4. `assay compare` renders a statistically defended verdict, and a GitHub
   Action blocks the pull request when that verdict is a regression or a
   budget breach.

Four constraints govern every boundary decision below. They are restated in
the affected sections; a design that violates any of them is wrong even if it
is convenient.

- **Deterministic-and-free CI.** No required check ever contacts a live
  provider (NFR-DET-001, NFR-COST-001). The simulated adapter proves harness
  logic; the Robin synthetic adapter proves integration; both are
  deterministic and cost zero dollars. All harness randomness is seeded and
  recorded (NFR-DET-002); clocks are injected (NFR-DET-003); simulated-agent
  end-to-end results are byte-stable across runs and platforms (NFR-DET-004).
- **Local-first.** All state lives in one per-project SQLite database plus a
  content-addressed blob directory (ADR-0008). The only egress is an explicit
  provider call (NFR-PRIV-001). There is no hosted service, no telemetry
  (NFR-PRIV-006), and no component that requires a network to render a
  result already on disk.
- **Subprocess trust boundary to subjects.** The agent under test is an
  untrusted subprocess speaking the versioned `assay-adapter/1` JSONL
  contract (ADR-0005), executed inside a sandbox (ADR-0004). Assay never
  links a subject in-process and never imports Robin's provider abstraction.
  Everything a subject emits — events, tool output, workspace contents — is
  untrusted input validated at the boundary.
- **Statistics-or-silence.** No comparing surface renders a single-run
  boolean as a quality claim (FR-STAT-001). A difference is a "regression"
  only after the ADR-0006 tests say so; otherwise the wording contract
  permits exactly "no significant difference at the stated MDE" or
  "insufficient data" (FR-STAT-007). The wording contract is enforced by one
  function in one package (§10.2), not by author discipline.

Additional invariants, in the Robin style:

- **Task outcome and run lifecycle are orthogonal.** Infrastructure error is
  never scored as task failure (FR-RUN-003). A sandbox that fails to start
  does not make the agent look worse.
- **Reruns append; nothing mutates.** A run record, once persisted, is never
  overwritten (FR-RUN-009). Comparisons pair immutable records.
- **Redaction precedes persistence.** Every byte from an adapter, tool, or
  environment passes the ADR-0010 redaction boundary before it is written
  anywhere; redaction failure fails closed (`redaction_failed`).
- **Budgets fail closed.** Unreconciled usage cannot pass a cost budget
  (ADR-0009, FR-BUD-003). A runaway suite aborts at its declared dollar
  ceiling (FR-BUD-008).
- **Cleanup is guaranteed, not best-effort.** Labeled containers and volumes
  are reaped on exit, on signal, and on next start (FR-SAND-006).
- **Composition happens once.** `apps/cli` is the only composition root.
  Domain packages receive `Clock`, `IdSource`, `SeedSource`, and
  `DiagnosticSink` as dependencies and never touch `process.env`, global
  time, global randomness, or stdout.

## 2. Component boundary map

### 2.1 Dependency rule

Dependencies point inward toward `packages/contracts`. Adapters depend on
ports; ports never depend on adapters. The reporting package never imports
the sandbox driver. The stats package imports nothing that performs I/O. The
viewer server reads the store through the same query interface reports use
and holds no write capability at the type level.

```text
apps/cli, apps/action, apps/viewer
  -> runner, reporting, run-store, config
     -> stats, budgets, judge, trajectory, assertions
        -> adapter-core, sandbox, providers, task-format, redaction
           -> contracts
```

`adapter-simulated` and `adapter-robin` depend on `adapter-core` only.
`fixtures/` is data, not code, and is imported by tests alone. Architecture
checks in CI enforce this graph (NFR-MAINT-001); an edge not listed here is
a build failure, not a review comment.

### 2.2 Package responsibility table

| Package | Responsibility | Owns | Must not do |
| --- | --- | --- | --- |
| `apps/cli` | `assay` executable: argument parsing, composition root, exit-code mapping, signal wiring | CLI surface (§7 of the requirements), top-level AbortSignal tree | Business logic, direct Docker or SQLite calls, provider SDK usage |
| `apps/action` | GitHub Action wrapper around `assay run` + `assay compare`; PR comment upsert; status check | Action inputs schema, comment idempotency key, least-privilege permission manifest | Statistics, storage, any logic beyond invoking the CLI and posting results |
| `apps/viewer` | React SPA plus loopback read-only server started by `assay view` | Route table, session token, diff UI, render performance budget | Mutation endpoints, network egress, importing anything but `run-store` queries and `contracts` |
| `packages/contracts` | Branded IDs, canonical JSON encoder, error taxonomy, `AssayEvent` union, shared value types | The single error-category enum, event schema versions, ID formats | I/O of any kind, dependencies on any other Assay package |
| `packages/runner` | Run planning, task-run lifecycle reducer, orchestration, bounded scheduling, cancellation, and cleanup policy | State transitions, task-run admission order, run outcome aggregation | Process composition, reading global env/time/randomness, constructing concrete adapters, sandboxes, or stores |
| `packages/task-format` | YAML parsing, JSON Schema validation, `extends` merge, `matrix` expansion, format migration | Task/suite schemas, deterministic instance IDs, content hashing of tasks | Executing checkers, touching the network, reading anything outside given paths |
| `packages/assertions` | Deterministic assertion engine and checker-worker host | Assertion evaluation order, checker worker limits, `AssertionResult` production | Judge calls, sandbox control, trajectory metric computation |
| `packages/trajectory` | Trajectory record schema, capture pipeline, canonical serialization, metric computation | Turn model, alignment keys, metric versions, truncation markers | Redaction rules (consumes `redaction`), storage layout, statistics |
| `packages/adapter-core` | `assay-adapter/1` contract types, JSONL framing, handshake negotiation, conformance suite | Frame schemas, size limits, malformed-frame policy, tier assignment | Spawning specific agents, provider pricing, sandbox management |
| `packages/adapter-simulated` | In-repo deterministic scripted agent | Scenario file format, deterministic event emission | Network access, nondeterminism of any kind, dependence on Robin |
| `packages/adapter-robin` | Reference adapter wrapping pinned `robin --print` stream-JSON | Robin event mapping table, pinned version/flag spellings, pinned-preview tier record | Importing Robin packages in-process, patching Robin behavior |
| `packages/providers` | BYOK model/judge clients, pricing catalog, usage reconciliation | Pricing catalog versions, reconciliation tolerances, recorded-provider fixtures | Persisting credentials, being reachable from required CI checks |
| `packages/sandbox` | OCI driver over the Docker Engine API: materialization, limits, snapshot, reaper | Container labels, network policy modes, isolation labels, `--unsafe-host-exec` gate | Trusting fixture content, granting ambient credentials, silent host fallback |
| `packages/budgets` | Budget evaluation over reconciled run summaries | `BudgetVerdict`, median/p95 selection, runaway-suite guard math | Collecting usage itself, rendering reports, statistical tests |
| `packages/stats` | Wilson, Newcombe, Boschloo/Fisher, BCa bootstrap, BH FDR, MDE, flake classes | Every METHODOLOGY formula, seeds for resampling, numeric tolerances | I/O, clocks, unseeded randomness, wording of verdicts |
| `packages/judge` | Rubric loading, calibration storage interface, agreement computation, isolation transform, k-vote majority | Kappa gate (≥ 0.6), same-family policy flagging, vote aggregation | Direct HTTP (uses `providers`), skipping calibration checks |
| `packages/run-store` | SQLite + blob store, migrations, corruption quarantine | DDL (§7), transaction boundaries, blob addressing, migration runner | Interpreting results, computing metrics, serving HTTP |
| `packages/reporting` | Delta tables, md/json renderers, wording contract | The only verdict-phrase function, report schemas, exit-code derivation inputs | Running statistics (consumes `stats` output), storage writes |
| `packages/redaction` | Versioned pattern ruleset, entropy scanner, planted-credential corpus | Rule versions, redaction manifest format, fail-closed semantics | Persisting anything, being bypassable by any capture path |
| `packages/config` | Config schema, precedence resolution, startup validation | `assay.config.yaml` schema, `ASSAY_*` env mapping, unknown-key rejection | Reading env outside injected accessor, holding secret bytes |

### 2.3 Trusted and untrusted inputs per boundary

Untrusted content may influence what an agent proposes and what a report
describes. It can never directly invoke harness capability, alter policy,
select credentials, or bypass redaction.

| Boundary | Trusted inputs | Untrusted inputs | Validation at the boundary |
| --- | --- | --- | --- |
| CLI entry | argv shape, injected env accessor | argv values, env values | Typed parser; unknown flags and keys rejected (`invalid_invocation`, `invalid_configuration`) |
| Task loading | published JSON Schemas | task/suite YAML, checker module paths | Ajv validation, unknown-field rejection (FR-TASK-002), no execution at parse (FR-TASK-003) |
| Checker execution | checker time/memory limits | checker module code, its output | Restricted worker; crash/timeout is `assertion_error`, distinct from failure (FR-ASSERT-004) |
| Fixture materialization | declared content hash | fixture archive bytes | sha256 verify before any byte reaches a container (NFR-SEC-007, `fixture_hash_mismatch`) |
| Adapter stdout | contract schema, size limits | every frame byte | Frame-by-frame schema validation; malformed frames bounded, classified, never crash the harness (FR-ADAPT-005) |
| Adapter stderr | capture bound | all bytes | Bounded ring buffer, redacted, stored as diagnostic blob only |
| Workspace snapshot | snapshot mechanism | all file contents | Content-addressed; assertions read it hermetically (FR-ASSERT-008); never executed on the host |
| Provider responses | client schema | response bodies, usage claims | Parsed from `unknown`; reconciled against the pricing catalog (ADR-0009) |
| Judge output | vote schema | verdict text, rationale | Parsed, majority-aggregated; subject text entered only via the isolation transform (FR-JUDGE-006) |
| Store on open | migration ledger | database file bytes | Integrity check; corruption quarantines, never silently drops (FR-TRACE-009) |
| Viewer requests | route table, token | URL, query params | Token check, read-only routes, no path outside the store (FR-TRACE-008) |

Conditionally trusted: checker modules and rubrics are repository-reviewed
content, but they still execute (checkers) or steer a model (rubrics) under
limits, because "reviewed" is not "trusted with the harness process".

## 3. Execution model: the `assay run` pipeline

`assay run <suite> --variant <name> [-n N] [--adapter X] [--seed S]
[--dry-run] [--unsafe-host-exec]` executes the ordered pipeline below. Every
step names its inputs, outputs, failure category from the taxonomy in
`packages/contracts`, and cancellation behavior. Cancellation semantics
default to: observe the AbortSignal, stop starting new work, settle owned
work, persist what §4 permits, and propagate.

### 3.1 Step 1 — configuration resolution

- Inputs: argv, injected env accessor (`ASSAY_*`), `assay.config.yaml`,
  built-in defaults.
- Outputs: one immutable `ResolvedConfig` value with source provenance per
  field; its canonical-JSON hash for the run record.
- Failure: `invalid_invocation` (argv), `invalid_configuration` (env/file,
  unknown keys, type errors). Exit code 4.
- Cancellation: not cancellable; completes in-memory in bounded time.

### 3.2 Step 2 — suite load and validation

- Inputs: suite path, task paths it selects, published JSON Schemas.
- Outputs: validated `SuiteDefinition` and `TaskDefinition[]` with per-task
  canonical content hashes; deterministic task ordering (FR-TASK-006).
- Failure: `suite_invalid`, `task_invalid`, `checker_invalid` (checker
  module missing or not exporting `check`). Exit code 4. `format_version`
  with an unknown major is `task_invalid` with a stable message
  (FR-TASK-007).
- Cancellation: abort between files; no side effects to undo.

### 3.3 Step 3 — plan expansion

- Inputs: validated suite, `--variant`, `-n` (default n = 10), `--seed`.
- Outputs: the execution plan — the cross product tasks × n × variant as a
  deterministic list of planned task runs. Each planned run carries a
  derived seed: `seed_i = H(rootSeed, taskContentHash, repetition)` where H
  is sha256 truncated to 64 bits, so per-run seeds are stable under plan
  reordering. `extends` and `matrix` were already expanded at load
  (FR-TASK-004, FR-TASK-005); expansion here multiplies by repetition only.
- Failure: `internal_invariant` (duplicate planned IDs — impossible unless
  hashing is broken).
- Cancellation: pure computation; abort discards the plan.

### 3.4 Step 4 — preflight and dry-run

- Inputs: plan, `ResolvedConfig`, pricing catalog version, Docker socket
  probe, adapter descriptor probe.
- Outputs: spend ceiling estimate via the published cost model
  (suite size × n × pricing, NFR-COST-003). With `--dry-run`, the resolved
  plan (tasks, variants, n, estimated spend ceiling) prints and the process
  exits 0 with no side effects (FR-RUN-012). Without it, preflight asserts
  the projected spend does not already exceed the declared suite ceiling.
- Failure: `sandbox_unavailable` (no Docker socket and no
  `--unsafe-host-exec`; never silent degradation, FR-SAND-009),
  `adapter_unavailable`, `budget_exceeded` (projection over ceiling before
  any spend). Exit codes 5, 5, 2 respectively.
- Cancellation: abort before the run record exists; nothing persisted.

### 3.5 Step 5 — run record creation

- Inputs: plan, config hash, suite/task content hashes, variant, adapter
  identity, model identity, seeds, harness version.
- Outputs: one `runs` row binding all of the above (FR-RUN-007); the
  `RunPlanned` event.
- Failure: `storage_locked`, `storage_migration_required` (migrations are
  explicit, never on write), `storage_corrupt`.
- Cancellation: after this point cancellation must persist a terminal
  `cancelled` state on the run (FR-RUN-006).

### 3.6 Step 6 — bounded-concurrency scheduling

- Inputs: planned task runs, `concurrency` from config (default 4).
- Outputs: task runs admitted to the per-task-run pipeline (§3.7) through a
  semaphore of width `concurrency`. Ordering is plan order; the scheduler
  never reorders admissions, so identical inputs schedule identically.
  Records of different task runs never interleave within one trajectory
  (FR-RUN-005): each pipeline owns its collector exclusively.
- Failure: none of its own; it aggregates child outcomes.
- Cancellation: stops admitting; running children receive the abort and
  settle; the scheduler waits for all children before returning (§13).

### 3.7 Step 7 — per-task-run pipeline

Each admitted task run executes sub-steps 7a–7k, driving the §4 state
machine. A sub-step failure moves the task run to its terminal state and
never aborts sibling task runs; only the runaway-spend guard and
cancellation abort the suite.

#### 3.7a Materialize

- Inputs: `FixtureRef`, content-addressed fixture archive or in-repo
  directory, `SandboxSpec`.
- Outputs: verified fixture bytes staged for the sandbox; the
  `FixtureMaterialized` event. State: `planned → materializing`.
- Failure: `fixture_unavailable`, `fixture_hash_mismatch` →
  `failed_infrastructure`.
- Cancellation: abort discards staging; nothing to snapshot.

#### 3.7b Sandbox start

- Inputs: staged fixture, image digest (pinned, FR-SAND-011), limits,
  network policy.
- Outputs: a running container with the fixture tar-streamed into its
  private workdir volume; `SandboxStarted` with the isolation label.
- Failure: `sandbox_unavailable`, `sandbox_start_failed` →
  `failed_infrastructure`.
- Cancellation: destroy the container (idempotent), then settle.

#### 3.7c Adapter spawn and handshake

- Inputs: adapter command from the descriptor, `AdapterRunSpec`, the
  sandbox exec facility (adapters run inside the sandbox, FR-ADAPT-009).
- Outputs: a live adapter subprocess whose first stdout line is a valid
  handshake frame; negotiated contract version; `AdapterHandshake`. State:
  `materializing → agent_running`.
- Failure: `adapter_unavailable` (spawn), `adapter_protocol_error` (bad or
  absent handshake within 10 s), `adapter_nonconformant` (unknown contract
  major, FR-ADAPT-010) → `failed_infrastructure`.
- Cancellation: SIGTERM to the adapter, 5 s grace, SIGKILL, then 3.7b
  cleanup.

#### 3.7d Event collection with capture-boundary redaction

- Inputs: adapter stdout JSONL stream, adapter stderr, the redaction
  engine.
- Outputs: an in-memory ordered trajectory under construction. Every frame
  is: length-checked, parsed, schema-validated, redacted (ADR-0010), then
  appended. `ModelRequestStarted`, `ModelResponseRecorded`,
  `ToolCallRecorded`, `UsageReconciled` / `UsageUnreconciled` events emit
  as frames arrive. Usage reconciliation runs per model request here
  (ADR-0009).
- Failure: `redaction_failed` fails the run closed as infrastructure error;
  malformed frames follow the §6.4 policy; exceeding the frame budget is
  `adapter_protocol_error`. Timeouts here are `sandbox_timeout` →
  `timed_out` (harness-side monotonic clock, FR-RUN-008).
- Cancellation: stop reading, terminate the adapter per 3.7c, keep the
  partial trajectory with a truncation marker (FR-TRAJ-009).

#### 3.7e Agent exit

- Inputs: adapter process exit status, terminal frame
  (`run_completed`/`run_failed`).
- Outputs: exit classification per §6.6 termination semantics. State:
  `agent_running → collecting`.
- Failure: exit without a terminal frame, or frames after the terminal
  frame: `adapter_protocol_error`; trajectory marked incomplete
  (FR-TRAJ-005).
- Cancellation: already settled by 3.7d.

#### 3.7f Workspace snapshot

- Inputs: the sandbox handle after agent exit.
- Outputs: content-addressed workspace snapshot taken from the container
  (FR-SAND-008); `WorkspaceSnapshotTaken`. State: `collecting → asserting`.
- Failure: `sandbox_limit_exceeded` (snapshot over the declared disk
  bound), `sandbox_start_failed` reused for a dead container →
  `failed_infrastructure`.
- Cancellation: skip the snapshot; assertions cannot run; terminal
  `cancelled`.

#### 3.7g Layered assertions

- Inputs: assertion specs in declared order, the workspace snapshot, the
  trajectory so far.
- Outputs: `AssertionResult[]`; one `AssertionEvaluated` event each. Layer
  order is deterministic → checker → judge and cannot be reordered so a
  judge runs before a cheaper layer (FR-ASSERT-002). Deterministic types:
  `exit_code`, `tests_pass`, `file_exists`, `file_contains`, `file_absent`,
  `json_schema`, `diff_matches`, `command_output` (FR-ASSERT-001).
  `tests_pass` and `command_output` execute inside the sandbox before it is
  destroyed, parsing exit status only (FR-ASSERT-010).
- Failure: `assertion_error` per assertion (checker crash/timeout,
  FR-ASSERT-004); an errored assertion makes the task outcome `error`, not
  `fail`.
- Cancellation: stop between assertions; evaluated results persist;
  terminal `cancelled`.

#### 3.7h Optional judge

- Inputs: judge assertion specs, rubric, calibration record, `providers`
  client, budgets.
- Outputs: k = 3 votes with the distribution stored (FR-JUDGE-009);
  `JudgeVoteRecorded` per vote. State passes through `judging`. Loading
  already rejected judge assertions lacking rubric + calibration
  (FR-ASSERT-006); here the kappa ≥ 0.6 gate decides gating versus
  advisory-only (FR-JUDGE-004).
- Failure: `judge_unavailable` (provider), `judge_uncalibrated` (stale
  calibration after rubric change, FR-JUDGE-010) → assertion error, and
  infrastructure error if no judge call can proceed at all.
- Cancellation: abort in-flight provider calls via signal; recorded votes
  persist; terminal `cancelled`.

#### 3.7i Trajectory scoring

- Inputs: the complete (or truncated) trajectory, the adapter tool catalog
  with semantic classes (FR-ADAPT-006).
- Outputs: versioned trajectory metrics — tool-selection correctness,
  ordering sanity, redundant-call count, read-before-write discipline,
  error-recovery-vs-loop, turns-to-completion, cost-per-turn (FR-TRAJ-003);
  `TrajectoryScored`. State: `[judging →] scored`.
- Failure: metric computation on an incomplete trajectory yields
  `assertion_error` for any trajectory assertion that needs the missing
  region; scoring itself throwing is `internal_invariant`.
- Cancellation: skipped; terminal `cancelled` before `scored`.

#### 3.7j Budget input aggregation

- Inputs: reconciled usage records, wall-clock and per-phase latencies
  (provider vs tool vs harness overhead, FR-BUD-006), tool-call count.
- Outputs: a `TaskRunSummary` suitable for `BudgetEvaluator.evaluate`.
  Per-task budget verdicts are not final here; §3.9 evaluates against the
  cross-run statistical summary (FR-BUD-004). The runaway guard updates the
  suite's running projected spend and aborts the whole suite when the
  declared dollar ceiling is exceeded (FR-BUD-008), fail-closed.
- Failure: `usage_unreconciled` marks the summary; the budget engine later
  fails it closed (FR-BUD-003).
- Cancellation: pure aggregation; skipped on cancel.

#### 3.7k Persist

- Inputs: everything above.
- Outputs: one transaction writing the task-run row, turns, tool calls,
  usage records, assertion results, judge votes, trajectory metrics, and
  blob references; then `TaskRunCompleted` and `SandboxDestroyed` after the
  container is removed. State: `scored → persisted → completed`.
- Failure: `storage_locked`, `storage_corrupt` → the task run cannot reach
  `persisted`; it is re-persisted by recovery or quarantined (§4.4).
- Cancellation: the transaction is atomic; either the terminal `cancelled`
  record commits or recovery handles it on next start.

### 3.8 Step 8 — suite aggregation

- Inputs: all terminal task-run records for this run.
- Outputs: per-task pass counts over n, Wilson 95% intervals, flake classes
  (always_pass k=n, always_fail k=0, unstable 0<k<n; "genuinely unstable"
  additionally requires the Wilson CI to exclude both 0 and 1 at n ≥ 10);
  `SuiteCompleted`.
- Failure: `internal_invariant` if any task run is nonterminal.
- Cancellation: aggregation still runs over whatever is terminal, labeled
  as a cancelled, incomplete run.

### 3.9 Step 9 — budget verdict

- Inputs: `TaskRunSummary[]` per task, declared per-task and per-suite
  budgets (total tokens, wall-clock ms, tool-call count, dollar cost,
  FR-BUD-001).
- Outputs: `BudgetVerdict` comparing declared statistics (median and p95 as
  declared) across runs; `BudgetEvaluated`. Breach is distinct from
  assertion failure with its own exit code and report row (FR-BUD-002).
- Failure: `budget_exceeded` (the verdict itself), `usage_unreconciled`
  summaries fail their dollar budgets closed.
- Cancellation: evaluated over completed task runs only, and the report
  labels the verdict as computed on a cancelled run.

### 3.10 Step 10 — report and exit

- Inputs: aggregation, budget verdict, run metadata.
- Outputs: the run report (md or json, §10), persisted report reference,
  process exit code: 0 success; 1 task failures; 2 budget breach; 3
  regression detected (only from `assay compare`); 4 invalid input/config;
  5 infrastructure error; 6 cancelled (FR-RUN-010). When multiple apply,
  the highest-precedence code wins in the order 5, 6, 2, 3, 1, 0; code 4
  can only occur before a run record exists.
- Failure: report rendering failure is `internal_invariant`; the stored run
  remains queryable by `assay report <run>`.
- Cancellation: already terminal; the report states cancellation.

## 4. Task-run lifecycle state machine

### 4.1 States and diagram

Every task run follows the fixed state machine below. An illegal transition
is an `internal_invariant` error (FR-RUN-002). Task outcome
(`pass | fail | error`) is orthogonal to lifecycle state and is recorded
only on runs that reach `completed` (FR-RUN-003).

```text
                +--------------------------------------------------+
                |                                                  |
planned -> materializing -> agent_running -> collecting -> asserting
                                                              |
                                                        [judging]  (only if
                                                              |     judge
                                                              v     asserts)
                                                           scored
                                                              |
                                                              v
                                                          persisted
                                                              |
                                                              v
                                                          completed

Any nonterminal state ---------> failed_infrastructure   (terminal)
agent_running, collecting -----> timed_out               (terminal)
Any nonterminal state ---------> cancelled               (terminal)
persistence-integrity failure -> quarantined             (terminal)
```

Terminal states: `completed`, `failed_infrastructure`, `timed_out`,
`cancelled`, `quarantined`. No transition leaves a terminal state.

### 4.2 Transition table

| From | To | Trigger | Emitted `AssayEvent` |
| --- | --- | --- | --- |
| (none) | `planned` | Scheduler admits the planned task run | `RunPlanned` |
| `planned` | `materializing` | Fixture staging begins | — |
| `materializing` | `agent_running` | Fixture verified, sandbox started, adapter handshake accepted | `FixtureMaterialized`, `SandboxStarted`, `AdapterHandshake` |
| `agent_running` | `collecting` | Adapter terminal frame observed and process exited | `ModelRequestStarted`, `ModelResponseRecorded`, `ToolCallRecorded`, `UsageReconciled`/`UsageUnreconciled` during; none at the edge |
| `collecting` | `asserting` | Workspace snapshot content-addressed | `WorkspaceSnapshotTaken` |
| `asserting` | `judging` | All deterministic and checker assertions evaluated and at least one judge assertion exists | `AssertionEvaluated` (per assertion) |
| `asserting` | `scored` | All assertions evaluated, no judge assertions | `AssertionEvaluated`, `TrajectoryScored` |
| `judging` | `scored` | All judge votes recorded and aggregated | `JudgeVoteRecorded` (per vote), `TrajectoryScored` |
| `scored` | `persisted` | Task-run transaction committed | — |
| `persisted` | `completed` | Sandbox destroyed and cleanup verified | `TaskRunCompleted`, `SandboxDestroyed` |
| any nonterminal | `failed_infrastructure` | Any infrastructure-category error (§3.7 per step) | `RunFailed` with the taxonomy category |
| `agent_running`, `collecting` | `timed_out` | Harness-side monotonic per-task deadline fires (FR-RUN-008) | `RunFailed` with `sandbox_timeout` |
| any nonterminal | `cancelled` | AbortSignal observed and owned operations settled | `RunCancelled` |
| any | `quarantined` | Persisted record fails integrity verification | `RunFailed` with `storage_corrupt` |

The suite-level timeout cancels remaining task runs (they end `cancelled`),
while the per-task timeout ends only that task run as `timed_out`.

### 4.3 Idempotency rules

- Planned task runs are identified by the natural key
  `(run_id, task_id, repetition)`; `appendTaskRun` is idempotent on that
  key, so a retried persist cannot create a duplicate row.
- `putBlob` is idempotent by content hash; re-writing identical bytes is a
  no-op that must succeed even if the blob exists.
- `SandboxHandle.destroy()` is idempotent and always attempted; destroying
  an already-removed container succeeds silently.
- Event emission is at-least-once toward the diagnostic sink but exactly-once
  in the durable record: the persist transaction is the sole durable truth,
  and events replayed from it carry their original IDs.
- Reruns never mutate: a retry after `failed_infrastructure` is a new task
  run with a new `attempt` counter, appended, never overwriting (FR-RUN-009).

### 4.4 Crash and recovery semantics

A crashed harness process must leave the store recoverable and sandboxes
reapable on next start (FR-RUN-011). On every start (`assay run`, `assay
gc`, any store-opening command):

1. Open the store; run SQLite `PRAGMA quick_check`. Failure quarantines the
   database (§7.6) and exits with `storage_corrupt` (exit 5).
2. Scan for task runs whose recorded state is nonterminal. Classify:
   - `planned`, `materializing`: no agent ever ran. Mark
     `failed_infrastructure` with cause `harness_crash`. These are
     re-entrant — a new attempt may be planned because no external effect
     with observable cost occurred.
   - `agent_running`, `collecting`: a subject may have run and spent money.
     Mark `failed_infrastructure` with cause `harness_crash`; persist any
     partial trajectory found in the write-ahead spool with an explicit
     truncation marker (FR-TRAJ-009). Never re-entrant automatically:
     re-running is a new, human-initiated task run, because silently
     repeating provider spend after a crash violates the budget model.
   - `asserting`, `judging`, `scored`: the trajectory is durable; assertion
     and scoring are re-entrant pure(ish) computation over stored inputs.
     Recovery re-executes from the last durable input and proceeds to
     `persisted`. Judge votes already recorded are kept; only missing votes
     are re-requested.
   - `persisted`: verify the transaction actually committed; if the row set
     is complete, advance to `completed` after reaping the sandbox;
     otherwise quarantine that task run (not the whole store).
3. Run the sandbox reaper (§5.7): remove every container and volume
   labeled with this project's store identity whose task run is terminal.
4. Emit a recovery summary diagnostic naming every touched task run.

Quarantine is per-record where possible (a task run whose blobs fail hash
verification) and whole-store only when SQLite-level integrity fails.
Quarantined records are excluded from comparisons and marked in every
report; they are never silently dropped (FR-TRACE-009).

## 5. Sandbox architecture (ADR-0004)

### 5.1 Isolation boundary statement

The sandbox is an OCI container driven through the Docker Engine API
(Docker Desktop or a rootless Docker/Podman-compatible socket). The
isolation claim is explicitly bounded: the container shares a kernel with
the host through the container runtime, and the Docker daemon is trusted. A
compromised kernel or daemon is outside the defended boundary. The defended
claims — filesystem containment, network denial, resource limits, no
ambient credentials — are each backed by named escape-attempt tests
(filesystem, network, process, resource exhaustion, fixture poisoning) that
run in CI and are cataloged in THREAT_MODEL.md (FR-SAND-007, NFR-SEC-002).
A container is never presented as a security claim without that citation.

### 5.2 Container topology

One dedicated container per task run (FR-SAND-001). Concurrent sandboxes
share nothing writable (FR-SAND-012).

```text
Harness process (host)
  | Docker Engine API (unix socket)
  v
Container  assay-run-<task_run_id>
  image:        pinned by digest from the task/suite (FR-SAND-011)
  rootfs:       read-only
  /workspace:   container-private named volume (fixture materialized here)
  /tmp:         tmpfs, size-capped
  network:      none | task-declared allowlist
  limits:       cpus, memory, pids; disk via volume quota
  env:          only task-declared variables (FR-SAND-004)
  labels:       assay.store=<store_id>, assay.run=<run_id>,
                assay.task_run=<task_run_id>, assay.created=<rfc3339>
  processes:    adapter subprocess + whatever the agent spawns
```

The container never sees the harness checkout, the store, the host home
directory, or the Docker socket (FR-SAND-002). The adapter runs inside the
container under the task's isolation policy (FR-ADAPT-009).

### 5.3 Fixture materialization data flow

1. Resolve `FixtureRef` to a content-addressed archive in the blob store or
   an in-repo directory; no network fetch at load (FR-TASK-008).
2. Verify sha256 of the archive against the declared hash before any byte
   is used (NFR-SEC-007). Mismatch: `fixture_hash_mismatch`, terminal.
3. Create the named workspace volume; start the container with the volume
   mounted at `/workspace` and the entrypoint parked.
4. Stream the fixture as a tar archive through the Engine API
   put-archive endpoint into `/workspace`. The tar stream is produced by
   the harness from verified bytes; symlinks pointing outside the archive
   root and hardlinks are rejected during tar construction (fixture
   poisoning defense).
5. Record the materialized manifest (path, mode, size, sha256 per file) as
   a blob; emit `FixtureMaterialized`.

Edge cases: an empty fixture materializes an empty `/workspace`; a fixture
larger than the declared disk limit fails as `sandbox_limit_exceeded`
before the agent starts; a duplicate path inside the archive is
`fixture_unavailable` (malformed archive).

### 5.4 Network policy modes

| Mode | Selection | Engine configuration | Isolation label |
| --- | --- | --- | --- |
| `none` (default) | Task omits network declaration (FR-TASK-009) | `--network none` | `isolated` |
| `allowlist` | Task declares explicit host:port entries | Dedicated bridge network plus a harness-managed egress proxy that permits only the declared entries and logs every connection attempt | `network_allowlisted` |
| `unsafe host exec` | `--unsafe-host-exec` flag only | No container at all; §5.8 | `unsafe_host` |

Any mode other than `none` downgrades the run's isolation label
(FR-SAND-003), and the label travels into the run record, every report, and
every comparison that includes the run.

### 5.5 Limit enforcement points

| Limit | Enforced by | Point | Breach category |
| --- | --- | --- | --- |
| CPU | Engine `NanoCpus` | Container create | `sandbox_limit_exceeded` |
| Memory | Engine memory + swap caps | Container create; OOM kill observed via wait status | `sandbox_limit_exceeded` |
| Pids | Engine `PidsLimit` | Container create | `sandbox_limit_exceeded` |
| Disk | Volume size quota + snapshot size check | Volume create; snapshot (§5.6) | `sandbox_limit_exceeded` |
| Wall clock | Harness-side monotonic timer | §3.7d collection loop; kills container on expiry | `sandbox_timeout` → `timed_out` |

Limit breaches are a distinct error category from task failure and from
budget breach (FR-SAND-005). Hard kill limits are independent of budget
accounting (FR-BUD-007): a run can be killed at the wall-clock limit even
though its token budget was healthy.

### 5.6 Workspace snapshot mechanism

After the adapter exits, and before assertions:

1. Stop the container's remaining processes (SIGKILL after grace; the agent
   already exited, but children may linger).
2. Stream `/workspace` out through the Engine API get-archive endpoint.
3. Rewrite the tar deterministically: entries sorted by path, mtimes
   zeroed, uid/gid zeroed, and per-file sha256 computed.
4. Store the deterministic tar as one blob; store the manifest (path, mode,
   size, sha256) as another; emit `WorkspaceSnapshotTaken` with both
   hashes.

Assertions evaluate hermetically against this snapshot and manifest, never
against harness host state (FR-ASSERT-008). `tests_pass` and
`command_output` are the exception in timing only: they execute inside the
still-running sandbox before step 1, and their results are captured into
the trajectory before the snapshot seals.

### 5.7 Reaper design

The reaper provides guaranteed cleanup (FR-SAND-006). It runs:

- on process start (before scheduling, §4.4 step 3);
- on normal exit (after the last persist);
- on signal (from the cancellation path, §13);
- on demand via `assay gc`.

Algorithm:

1. List containers and volumes with label `assay.store=<store_id>`.
2. For each, look up the task run in the store. Terminal task run, or no
   record at all: remove container (force) and volume.
3. Nonterminal task run owned by a live harness process (lock held): skip.
4. Nonterminal task run with no live owner: remove, then apply §4.4
   classification to the record.
5. Report reclaimed counts; failures to remove are diagnostics plus a
   nonzero `assay gc` exit, never silent.

The label scheme makes the reaper safe on shared Docker daemons: it never
touches a container it did not label.

### 5.8 Unsafe host-exec mode

`--unsafe-host-exec` exists for environments with no container runtime
(FR-SAND-010). It runs the adapter as a direct host subprocess in a temp
directory materialized from the verified fixture. It enforces wall-clock
timeout and env allowlisting but no filesystem, network, cpu, memory, or
pids containment. Consequences, all mandatory:

- the run's isolation label is `unsafe_host`;
- every report, comparison, and export containing the run renders a
  persistent banner naming the mode;
- sandbox-dependent assertions (`tests_pass`, `command_output`) execute on
  the host and say so in their results;
- absence of a Docker socket without this flag is a stable, actionable
  `sandbox_unavailable` error — never a silent fallback (FR-SAND-009).

## 6. Agent-adapter interface (`assay-adapter/1`, ADR-0005)

Assay owns a minimal adapter contract. An adapter is a subprocess that
receives one run specification and emits newline-delimited JSON events on
stdout. Assay does not import Robin's provider abstraction or any
`@guard/*` package; the subject/harness boundary is the process boundary.
AGENT_COMPATIBILITY.md publishes the JSON Schemas; this section defines the
architecture-level semantics they encode.

### 6.1 Framing and transport

- Transport: adapter stdin (harness → adapter), adapter stdout (adapter →
  harness), adapter stderr (unstructured diagnostics, bounded capture).
- Framing: one JSON object per line, UTF-8, LF terminated. No CR, no BOM,
  no blank lines, no partial-line flushes counted as frames.
- Frame size limit: 1 MiB (1,048,576 bytes) including the LF. An oversized
  line is a malformed frame (§6.5).
- Stream budget: 50,000 frames or 256 MiB total per task run, whichever
  comes first; exceeding it is `adapter_protocol_error` and terminates the
  adapter.
- Sequencing: every adapter frame carries `seq`, a positive integer
  starting at 1 and incremented by exactly 1. A gap or repeat marks the
  trajectory incomplete (FR-TRAJ-005) and counts as a malformed frame.
- Large payloads: any single string field over 262,144 bytes must be
  emitted truncated by the adapter with `truncated: true` and
  `original_sha256` set. The harness additionally truncates defensively at
  the same bound and records that it did so in the redaction manifest.

### 6.2 Handshake

The adapter's first stdout line, within 10 seconds of spawn, is a
`handshake` frame. Nothing else may precede it.

```json
{"type": "handshake", "seq": 1, "contract": "assay-adapter/1",
 "adapter": {"id": "adapter-simulated", "version": "1.0.0"},
 "tier": "full",
 "model": {"provider": "synthetic", "model": "scripted-v1",
           "family": "synthetic"},
 "tool_catalog": [
   {"name": "read_file", "semantic_class": "read"},
   {"name": "write_file", "semantic_class": "write"},
   {"name": "run_command", "semantic_class": "execute"}
 ],
 "capabilities": {"usage_reporting": true, "cost_reporting": false,
                  "streaming_text": true}}
```

Field rules:

- `contract` (string, required): `assay-adapter/<major>`. The harness
  accepts major 1 only; an unknown major is rejected with the stable error
  `adapter_nonconformant` before any other frame is read (FR-ADAPT-010).
- `adapter.id` (string, required): `[a-z0-9-]{1,64}`.
- `adapter.version` (string, required): SemVer.
- `tier` (enum, required): `full | trajectory | black_box`, the tier the
  adapter claims; conformance results may downgrade it (§6.9) but never
  upgrade it.
- `model` (object, required for `full`/`trajectory`, null allowed for
  `black_box`): `provider`, `model`, `family` strings identifying the
  subject model (FR-ADAPT-008). `family` feeds the judge same-family check
  (FR-JUDGE-005).
- `tool_catalog` (array, required for `full`/`trajectory`): each entry
  `{name, semantic_class}` with `semantic_class` in
  `read | write | execute` (FR-ADAPT-006). Names must be unique. Trajectory
  metrics that need tool semantics (read-before-write, FR-TRAJ-010) use
  exactly this catalog; a `tool_call` naming an uncataloged tool is valid
  but scores as semantic class `unknown`.
- `capabilities` (object, required): booleans only; unknown keys rejected.

### 6.3 Run specification (harness → adapter)

After validating the handshake, the harness writes exactly one line to
adapter stdin and closes nothing (stdin stays open to allow future
contract minors to add a cancel frame; in major 1 cancellation is
signal-based, §6.6).

```json
{"type": "run_spec", "contract": "assay-adapter/1",
 "task_id": "fix-null-deref", "task_run_id": "01J...",
 "prompt": "…the task prompt…",
 "workspace_path": "/workspace",
 "seed": "5f2a9c01d4e8b7a3",
 "env": {"TASK_DECLARED_VAR": "value"},
 "limits": {"wall_clock_ms": 600000},
 "budgets_advisory": {"total_tokens": 200000, "tool_calls": 100,
                      "usd_micros": 500000}}
```

- `seed` is the derived per-run seed (§3.3); deterministic adapters must
  key all internal randomness from it.
- `budgets_advisory` is informational; enforcement is harness-side only. An
  adapter may use it to self-limit but gains nothing by ignoring it.
- `env` contains only task-declared variables (FR-SAND-004). BYOK
  credentials, when a real provider is in use, are resolved at spawn time
  from env/OS keychain references and injected here by the harness without
  ever being persisted (NFR-SEC-004).

### 6.4 Event frames

Common envelope for every adapter → harness frame after the handshake:

- `type` (enum, required): one of the ten types below.
- `seq` (integer, required): §6.1 sequencing.
- `ts` (string, required): RFC 3339 UTC with millisecond precision. Used
  for display and latency attribution only; ordering authority is `seq`.

Frame types and their payload fields:

**`session_started`** — exactly one, immediately after the handshake.

- `session_id` (string, required): adapter-scoped opaque ID.

**`model_request`** — one per provider request the agent issues.

- `request_id` (string, required): unique within the run.
- `turn` (integer, required): 0-based agent turn index; monotonically
  nondecreasing across the run.
- `model` (object, required): same shape as handshake `model`; permits
  per-request model switching, which the trajectory records.
- `message_count` (integer, required): messages in the request.
- `input_summary_sha256` (string, required): hash of the canonical request
  body the adapter sent; the body itself is not transmitted (it may exceed
  frame limits and may duplicate provider-confidential formatting).

**`model_response`** — one per `model_request`, after it settles.

- `request_id` (string, required): must match an open `model_request`;
  unmatched IDs are malformed frames.
- `status` (enum, required): `ok | provider_error | timeout`.
- `stop_reason` (string, required when `ok`): adapter-normalized
  (`end_turn | tool_use | max_tokens | refusal | other`).
- `latency_ms` (integer, required): provider wall time observed by the
  adapter; the harness separately measures its own overhead (FR-BUD-006).
- `text` (string, optional): assistant text for this response, subject to
  the §6.1 truncation rule.

**`tool_call`** — one per complete tool invocation the agent decided on.

- `call_id` (string, required): unique within the run.
- `request_id` (string, required): the model response that proposed it.
- `tool` (string, required): catalog name or uncataloged name.
- `args` (object, required): complete arguments; never streamed fragments.

**`tool_result`** — one per `tool_call`, after execution inside the
sandbox.

- `call_id` (string, required): must match an open `tool_call`.
- `status` (enum, required): `ok | error | timeout`.
- `result` (string, required): output text, truncation rule applies.
- `duration_ms` (integer, required).

**`usage`** — one per `model_request`, carrying provider-reported usage
(ADR-0009).

- `request_id` (string, required).
- `prompt_tokens`, `completion_tokens`, `total_tokens` (integers,
  required, ≥ 0; `total` must equal the sum or the frame is malformed).
- `cost_usd_micros` (integer, optional): provider-reported dollars in
  micro-USD when the provider states them.
- `source` (enum, required): `provider | synthetic`. Synthetic runs report
  zero cost with `source: synthetic` and are excluded from spend reports
  by default.

**`text_output`** — zero or more; user-visible assistant text outside a
model response (e.g., final summary).

- `text` (string, required), truncation rule applies.

**`run_completed`** — terminal success frame; exactly one terminal frame
per run.

- `summary` (string, required): adapter's account of what it did.

**`run_failed`** — terminal failure frame.

- `category` (enum, required): `agent_gave_up | agent_crashed |
  provider_error | internal`.
- `message` (string, required).

**`log`** — zero or more; structured diagnostics.

- `level` (enum, required): `debug | info | warn | error`.
- `message` (string, required).

Validation rules that span frames:

1. Exactly one `session_started`, before any other event frame.
2. Every `model_response` and `usage` closes an open `model_request`;
   every `tool_result` closes an open `tool_call`. Unclosed pairs at
   termination mark the trajectory incomplete.
3. Exactly one terminal frame, and it must be the final frame; any frame
   after it is malformed.
4. All frames pass redaction before the harness retains them (§3.7d).

### 6.5 Malformed-frame policy

A frame is malformed when it is oversized, not valid UTF-8, not a single
JSON object, fails schema validation, violates sequencing, or violates a
cross-frame rule. Policy, in order:

1. The malformed line is captured (bounded to 4 KiB), redacted, and stored
   as a diagnostic with its classification; it never crashes the harness
   (FR-ADAPT-005).
2. The trajectory is marked incomplete; trajectory assertions over missing
   regions evaluate as `assertion_error`.
3. Collection continues, unless malformed frames exceed 10 for the run or
   the handshake itself was malformed — then the adapter is terminated and
   the task run fails with `adapter_protocol_error`.

### 6.6 Termination semantics

- Success: `run_completed`, then exit code 0 within 5 seconds.
- Agent-level failure: `run_failed`, then exit 0. The task outcome is
  scored from assertions; `run_failed` is evidence, not the verdict.
- Exit 0 without a terminal frame, exit nonzero with or without one, or
  stdout closing mid-frame: `adapter_protocol_error`; trajectory
  incomplete.
- Harness-initiated termination (timeout, cancel, frame budget): SIGTERM,
  5-second grace, SIGKILL; the partial trajectory persists with a
  truncation marker (FR-TRAJ-009).

### 6.7 Version negotiation

The contract version lives in the handshake `contract` field. Major 1 is
the only accepted major; minors are additive (new optional fields, new
frame types the harness may ignore when unknown-but-well-formed under the
minor's published schema). The harness records the negotiated version in
the run record. Rejection of an unknown major is a stable error before any
event processing (FR-ADAPT-010), and the conformance suite includes a
future-major fixture proving the rejection path.

### 6.8 TypeScript definitions

The master interfaces, expanded to full types. `packages/adapter-core`
owns these; `packages/contracts` owns the branded IDs.

```ts
export type AdapterTier = "full" | "trajectory" | "black_box";
export type ToolSemanticClass = "read" | "write" | "execute";

export interface ToolCatalogEntry {
  readonly name: string;
  readonly semanticClass: ToolSemanticClass;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly family: string;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: "assay-adapter/1";
  readonly tier: AdapterTier;
  readonly model: ModelIdentity | null;
  readonly toolCatalog: readonly ToolCatalogEntry[];
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface AdapterRunSpec {
  readonly taskId: TaskId;
  readonly taskRunId: TaskRunId;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly seed: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: { readonly wallClockMs: number };
  readonly budgetsAdvisory: {
    readonly totalTokens?: number;
    readonly toolCalls?: number;
    readonly usdMicros?: number;
  };
}

export interface AgentAdapter {
  readonly descriptor: AdapterDescriptor;
  start(spec: AdapterRunSpec, signal: AbortSignal): AsyncIterable<AdapterEvent>;
}

interface AdapterEventBase<T extends string> {
  readonly type: T;
  readonly seq: number;
  readonly ts: string; // RFC 3339 UTC, millisecond precision
}

export interface UsageReport {
  readonly requestId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsdMicros: number | null;
  readonly source: "provider" | "synthetic";
}

export type AdapterEvent =
  | (AdapterEventBase<"session_started"> & { readonly sessionId: string })
  | (AdapterEventBase<"model_request"> & {
      readonly requestId: string;
      readonly turn: number;
      readonly model: ModelIdentity;
      readonly messageCount: number;
      readonly inputSummarySha256: string;
    })
  | (AdapterEventBase<"model_response"> & {
      readonly requestId: string;
      readonly status: "ok" | "provider_error" | "timeout";
      readonly stopReason:
        | "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other"
        | null;
      readonly latencyMs: number;
      readonly text: string | null;
    })
  | (AdapterEventBase<"tool_call"> & {
      readonly callId: string;
      readonly requestId: string;
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    })
  | (AdapterEventBase<"tool_result"> & {
      readonly callId: string;
      readonly status: "ok" | "error" | "timeout";
      readonly result: string;
      readonly durationMs: number;
    })
  | (AdapterEventBase<"usage"> & { readonly usage: UsageReport })
  | (AdapterEventBase<"text_output"> & { readonly text: string })
  | (AdapterEventBase<"run_completed"> & { readonly summary: string })
  | (AdapterEventBase<"run_failed"> & {
      readonly category:
        | "agent_gave_up" | "agent_crashed" | "provider_error" | "internal";
      readonly message: string;
    })
  | (AdapterEventBase<"log"> & {
      readonly level: "debug" | "info" | "warn" | "error";
      readonly message: string;
    });
```

`start` wraps subprocess spawn, handshake validation, framing, and
per-frame schema checks, yielding only validated events; every consumer
above `adapter-core` sees `AdapterEvent`, never raw lines.

### 6.9 Conformance tiers

The conformance suite (`packages/adapter-core`, FR-ADAPT-002) exercises an
adapter against scripted expectations and assigns the effective tier:

| Tier | Requirements proven | Unlocks |
| --- | --- | --- |
| `full` | Handshake, all ten frame types, pairing rules, usage on every request, catalog completeness, termination semantics | Trajectory metrics, trajectory assertions, budget accounting on reconciled usage, diff view, judge assertions over trajectory excerpts |
| `trajectory` | As `full` minus `usage`/cost fidelity (tokens may be absent) | Trajectory metrics and assertions; token/dollar budgets unavailable — a suite declaring them against this adapter fails validation, not silently |
| `black_box` | Handshake, `session_started`, terminal frame, clean exit | Final-state assertions only; reports state the measurement limits explicitly (FR-ADAPT-007) |

A special annotation, `pinned-preview`, marks an adapter whose subject
contract is not yet frozen (§6.11); it composes with a tier rather than
replacing it.

### 6.10 Simulated adapter design

`adapter-simulated` is the deterministic in-repo agent that proves harness
logic with zero external dependencies (FR-ADAPT-003). It replays scripted
scenario files from `fixtures/trajectories/`:

- A scenario file is JSON: `{"scenario_version": 1, "steps": [...]}` where
  each step is either an emit instruction (an exact `AdapterEvent` payload
  minus `seq`/`ts`) or a directive: `sleep_ms` (virtual; realized only when
  the harness injects a real clock), `write_file {path, contents}` /
  `delete_file {path}` (applied inside `/workspace` so final-state
  assertions have real material), `misbehave` (emit a deliberately
  malformed line, exit early, exceed a frame budget — the negative-path
  levers the conformance and protocol tests need).
- Timestamps come from the injected clock; sequence numbers are assigned
  in order; all randomness derives from the run seed. Identical
  (scenario, seed, clock) inputs produce byte-identical event streams,
  which is what makes simulated end-to-end results byte-stable
  (NFR-DET-004, FR-RUN-004).
- Shipped scenarios cover: plain text answer, multi-turn tool use, tool
  error then recovery, an identical-call loop (for FR-TRAJ-006 loop
  detection), budget-relevant token ramps, `run_failed` categories, and
  every `misbehave` variant.

### 6.11 Robin reference adapter design

`adapter-robin` wraps a pinned Robin build invoked as
`robin --print <prompt> --output-format stream-json` (the exact preview
spelling it was tested against is pinned in the adapter's descriptor and
re-verified when Robin's automation contract freezes at Robin's R7 gate).
Until that freeze the adapter carries the `pinned-preview` annotation on
its tier. Robin's deterministic credential-free synthetic provider makes
the Robin end-to-end suite deterministic and free (NFR-DET-005); simulated
end-to-end remains the required gate evidence, Robin-synthetic is
integration evidence.

Mapping table, Robin stream-JSON application events → adapter frames:

| Robin event | Adapter frame | Rule |
| --- | --- | --- |
| `TurnQueued` / `TurnStarted` progress | `session_started` | Emitted once on the first Robin event of the turn |
| `ProviderTextDelta` | accumulated | Deltas buffer; no frame per delta |
| `AssistantMessageCompleted` | `model_response.text` and/or `text_output` | Sealed text flushes with the owning response |
| provider request start (invocation prepared) | `model_request` | `request_id` = Robin `ModelInvocationId`; `turn` from Robin turn index |
| provider completion / `ProviderUsageReported` | `model_response`, `usage` | Robin usage totals map to `UsageReport`; synthetic profile ⇒ `source: synthetic`, zero cost |
| `ProviderToolCallCompleted` / `ToolRequestNormalized` | `tool_call` | Complete normalized calls only; Robin fragments never map |
| `ToolExecutionCompleted` / `ToolExecutionFailed` | `tool_result` | Status `ok`/`error`; Robin timeout classification maps to `timeout` |
| `ToolOutputDelta` | accumulated into `tool_result.result` | Bounded by the §6.1 truncation rule |
| `TurnCompleted` | `run_completed` | Summary from Robin's final assistant message |
| `TurnFailed` | `run_failed` | Robin failure category → `provider_error` or `agent_crashed` |
| `TurnCancelled` | (none) | Harness cancellation already owns this path; the adapter exits nonzero and the harness classifies |
| Robin diagnostics on stderr | `log` or stderr capture | Structured where parseable, bounded capture otherwise |

Robin events with no mapping row (permission, checkpoint, extension
events) are dropped by the adapter and counted in a per-run
`unmapped_event_count` diagnostic, so contract drift after the R7 freeze
surfaces as a number, not silence. The adapter pins the Robin
version/commit in its descriptor `version`, and conformance re-runs
against the frozen contract before the annotation is removed.

## 7. Storage schema (ADR-0008)

One SQLite database per project at `.assay/assay.db`, WAL mode, plus a
content-addressed blob directory `.assay/objects/`. `packages/run-store`
is the only writer; the viewer and reports read through its query
interface.

### 7.1 SQLite DDL, schema version 1

All timestamps are RFC 3339 UTC strings with millisecond precision. All
dollar amounts are integer micro-USD. All hashes are lowercase hex sha256.
IDs are ULIDs generated by the injected `IdSource`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE migrations_applied (
  version      INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  checksum     TEXT    NOT NULL,   -- sha256 of the migration file
  applied_at   TEXT    NOT NULL
);

CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  completed_at       TEXT,
  harness_version    TEXT NOT NULL,
  suite_path         TEXT NOT NULL,
  suite_content_hash TEXT NOT NULL,
  variant            TEXT NOT NULL,
  adapter_id         TEXT NOT NULL,
  adapter_version    TEXT NOT NULL,
  contract_version   TEXT NOT NULL,
  adapter_tier       TEXT NOT NULL CHECK (adapter_tier IN
                       ('full','trajectory','black_box')),
  model_provider     TEXT,
  model_name         TEXT,
  model_family       TEXT,
  root_seed          TEXT NOT NULL,
  runs_per_task      INTEGER NOT NULL CHECK (runs_per_task >= 1),
  config_hash        TEXT NOT NULL,
  isolation_label    TEXT NOT NULL CHECK (isolation_label IN
                       ('isolated','network_allowlisted','unsafe_host')),
  status             TEXT NOT NULL CHECK (status IN
                       ('in_progress','completed','failed','cancelled')),
  exit_code          INTEGER
);
CREATE INDEX idx_runs_selector
  ON runs (suite_content_hash, variant, created_at);

CREATE TABLE task_runs (
  task_run_id         TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs (run_id),
  task_id             TEXT NOT NULL,
  task_content_hash   TEXT NOT NULL,
  repetition          INTEGER NOT NULL CHECK (repetition >= 0),
  attempt             INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  seed                TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN
                        ('planned','materializing','agent_running',
                         'collecting','asserting','judging','scored',
                         'persisted','completed','failed_infrastructure',
                         'timed_out','cancelled','quarantined')),
  outcome             TEXT CHECK (outcome IN ('pass','fail','error')),
  error_category      TEXT,
  sandbox_image_digest TEXT,
  trajectory_blob     TEXT,            -- sha256 into objects/
  trajectory_complete INTEGER NOT NULL DEFAULT 0
                        CHECK (trajectory_complete IN (0, 1)),
  snapshot_blob       TEXT,
  snapshot_manifest_blob TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  wall_clock_ms       INTEGER,
  harness_overhead_ms INTEGER,
  UNIQUE (run_id, task_id, repetition, attempt)
);
CREATE INDEX idx_task_runs_by_task
  ON task_runs (task_id, task_content_hash);

CREATE TABLE turns (
  turn_id       TEXT PRIMARY KEY,
  task_run_id   TEXT NOT NULL REFERENCES task_runs (task_run_id),
  turn_index    INTEGER NOT NULL CHECK (turn_index >= 0),
  alignment_key TEXT NOT NULL,        -- §8.3
  request_id    TEXT,
  stop_reason   TEXT,
  latency_ms    INTEGER,
  text_blob     TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  UNIQUE (task_run_id, turn_index)
);

CREATE TABLE tool_calls (
  tool_call_id   TEXT PRIMARY KEY,
  task_run_id    TEXT NOT NULL REFERENCES task_runs (task_run_id),
  turn_id        TEXT NOT NULL REFERENCES turns (turn_id),
  call_index     INTEGER NOT NULL CHECK (call_index >= 0),
  tool_name      TEXT NOT NULL,
  semantic_class TEXT NOT NULL CHECK (semantic_class IN
                   ('read','write','execute','unknown')),
  args_sha256    TEXT NOT NULL,
  args_blob      TEXT NOT NULL,
  result_status  TEXT CHECK (result_status IN ('ok','error','timeout')),
  result_blob    TEXT,
  duration_ms    INTEGER,
  UNIQUE (task_run_id, turn_id, call_index)
);
CREATE INDEX idx_tool_calls_by_name
  ON tool_calls (task_run_id, tool_name);

CREATE TABLE usage_records (
  usage_id            TEXT PRIMARY KEY,
  task_run_id         TEXT NOT NULL REFERENCES task_runs (task_run_id),
  request_id          TEXT NOT NULL,
  model_provider      TEXT NOT NULL,
  model_name          TEXT NOT NULL,
  prompt_tokens       INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens   INTEGER NOT NULL CHECK (completion_tokens >= 0),
  total_tokens        INTEGER NOT NULL CHECK (total_tokens >= 0),
  reported_usd_micros INTEGER,
  estimated_usd_micros INTEGER NOT NULL,
  pricing_catalog_version TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN
                        ('provider','synthetic')),
  reconciled          INTEGER NOT NULL CHECK (reconciled IN (0, 1)),
  token_discrepancy_ppm INTEGER,      -- parts per million, signed
  usd_discrepancy_micros INTEGER,     -- signed
  recorded_at         TEXT NOT NULL,
  UNIQUE (task_run_id, request_id)
);

CREATE TABLE assertion_results (
  assertion_result_id TEXT PRIMARY KEY,
  task_run_id     TEXT NOT NULL REFERENCES task_runs (task_run_id),
  assertion_index INTEGER NOT NULL CHECK (assertion_index >= 0),
  layer           TEXT NOT NULL CHECK (layer IN
                    ('deterministic','checker','judge','trajectory')),
  assertion_type  TEXT NOT NULL,
  target          TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN
                    ('pass','fail','error')),
  observed_blob   TEXT NOT NULL,
  expectation_blob TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  UNIQUE (task_run_id, assertion_index)
);

CREATE TABLE judge_votes (
  judge_vote_id   TEXT PRIMARY KEY,
  task_run_id     TEXT NOT NULL REFERENCES task_runs (task_run_id),
  assertion_index INTEGER NOT NULL,
  rubric_id       TEXT NOT NULL,
  rubric_version  TEXT NOT NULL,
  judge_provider  TEXT NOT NULL,
  judge_model     TEXT NOT NULL,
  judge_family    TEXT NOT NULL,
  same_family_override INTEGER NOT NULL CHECK
                    (same_family_override IN (0, 1)),
  vote_index      INTEGER NOT NULL CHECK (vote_index BETWEEN 0 AND 2),
  verdict         TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  rationale_blob  TEXT NOT NULL,
  usage_id        TEXT REFERENCES usage_records (usage_id),
  recorded_at     TEXT NOT NULL,
  UNIQUE (task_run_id, assertion_index, vote_index)
);

CREATE TABLE trajectory_metrics (
  task_run_id    TEXT NOT NULL REFERENCES task_runs (task_run_id),
  metric_id      TEXT NOT NULL,
  metric_version INTEGER NOT NULL CHECK (metric_version >= 1),
  value          REAL NOT NULL,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (task_run_id, metric_id, metric_version)
);

CREATE TABLE comparisons (
  comparison_id     TEXT PRIMARY KEY,
  baseline_run_id   TEXT NOT NULL REFERENCES runs (run_id),
  candidate_run_id  TEXT NOT NULL REFERENCES runs (run_id),
  created_at        TEXT NOT NULL,
  config_hash       TEXT NOT NULL,
  bootstrap_seed    TEXT NOT NULL,
  bootstrap_resamples INTEGER NOT NULL CHECK
                      (bootstrap_resamples = 10000),
  alpha_millis      INTEGER NOT NULL CHECK (alpha_millis = 50),
  fdr_q_millis      INTEGER NOT NULL CHECK (fdr_q_millis = 50),
  verdict_phrase    TEXT NOT NULL CHECK (verdict_phrase IN
                      ('regression_detected','improvement_detected',
                       'no_significant_difference','insufficient_data')),
  mde_millis        INTEGER NOT NULL,  -- minimum detectable effect ×1000
  report_blob       TEXT NOT NULL      -- full ComparisonReport JSON
);
CREATE INDEX idx_comparisons_pair
  ON comparisons (baseline_run_id, candidate_run_id);

CREATE TABLE calibrations (
  calibration_id    TEXT PRIMARY KEY,
  rubric_id         TEXT NOT NULL,
  rubric_version    TEXT NOT NULL,
  judge_provider    TEXT NOT NULL,
  judge_model       TEXT NOT NULL,
  item_count        INTEGER NOT NULL CHECK (item_count >= 50),
  percent_agreement REAL NOT NULL CHECK
                      (percent_agreement BETWEEN 0.0 AND 1.0),
  cohen_kappa       REAL NOT NULL CHECK
                      (cohen_kappa BETWEEN -1.0 AND 1.0),
  gate_eligible     INTEGER NOT NULL CHECK (gate_eligible IN (0, 1)),
  labeled_set_blob  TEXT NOT NULL,
  computed_at       TEXT NOT NULL,
  UNIQUE (rubric_id, rubric_version, judge_provider, judge_model)
);
```

Column notes:

- `alpha_millis` / `fdr_q_millis` / `mde_millis` store rates ×1000 as
  integers so comparison rows are byte-stable; the CHECK constraints pin
  the ADR-0006 constants and force a migration if they ever change.
- `gate_eligible` is stored, not derived at read time, so a report row and
  the gate decision can never disagree; the writer sets it to
  `cohen_kappa >= 0.6` (FR-JUDGE-004).
- `token_discrepancy_ppm` > 10,000 (1%) or `usd_discrepancy_micros`
  magnitude > 10,000 ($0.01) forces `reconciled = 0` (ADR-0009).

### 7.2 Blob store layout and content addressing

```text
.assay/objects/<sha256[0..2]>/<sha256>
```

- Every blob is written to a temp file in `.assay/tmp/`, hashed while
  streaming, fsynced, then hard-renamed to its final path. Rename onto an
  existing identical blob is a success; a hash collision with different
  bytes is `internal_invariant` (practically unreachable, still checked).
- Blobs are immutable after rename. Deletion happens only through
  `assay delete` / retention policy, which removes rows first, then any
  blob no row references (FR-TRACE-007).
- Blob classes: trajectory JSON, workspace snapshot tar, snapshot
  manifest, fixture archives, assertion observed/expected payloads over
  the inline size bound (4 KiB — smaller values inline in the column as
  canonical JSON), judge rationales, comparison reports, diagnostics.

### 7.3 Canonical JSON rules

One encoder in `packages/contracts` produces every hashed or persisted
JSON byte sequence:

1. UTF-8, no BOM.
2. Object keys sorted lexicographically by Unicode code point.
3. No insignificant whitespace.
4. Strings serialized with the shortest JSON escape (`\uXXXX` only where
   mandatory); no unpaired surrogates (rejected on input).
5. Numbers: integers only, in the range safe for 64-bit signed; anything
   fractional is scaled to an integer unit (micro-USD, milli-rates, ppm)
   or stored as a decimal string field. `NaN`/`Infinity` are rejected.
6. Timestamps: RFC 3339 UTC, exactly `YYYY-MM-DDTHH:MM:SS.mmmZ`.
7. No trailing newline; the hash covers exactly the emitted bytes.

These rules make FR-TRAJ-002 (byte-stable trajectories) and FR-RUN-004
(byte-identical simulated results) achievable properties instead of hopes.

### 7.4 Write atomicity

- All row writes for one task run commit in one transaction (§3.7k), after
  its blobs are durably renamed; a reader can therefore never see a row
  referencing a missing blob.
- WAL mode gives single-writer/multi-reader; the run process holds the
  write lock; `assay view` and `assay report` open read-only connections.
- A second concurrent writer receives `storage_locked` with the owning
  process ID, not a busy-wait.

### 7.5 Migration mechanics

- Migrations are forward-only, numbered, checksummed files applied by
  `assay db migrate` — explicit, never implicit on read (FR-TRACE-006).
- Opening a store whose `migrations_applied` max is below the binary's
  expectation yields `storage_migration_required` with the exact command
  to run; above it, the binary refuses (`storage_migration_required` with
  an upgrade-the-binary message).
- CI keeps fixture databases at every historical version and proves each
  migration path plus post-migration query equivalence (FR-TASK-011's
  storage analog).

### 7.6 Corruption detection and quarantine

- On open: `PRAGMA quick_check`; on any failure the database file and its
  WAL/SHM are renamed to `assay.db.quarantined.<timestamp>` and the
  command exits `storage_corrupt`. Nothing is auto-repaired; recovery
  guidance points at export from the quarantined copy.
- On blob read: bytes are re-hashed and compared to the path name;
  mismatch quarantines that record (its task run becomes `quarantined`,
  excluded from comparisons, visible in reports) — detected and
  quarantined, never silently dropped (FR-TRACE-009).

## 8. Trajectory record schema

### 8.1 Record structure

A trajectory is one canonical-JSON document (rules §7.3) stored as a blob
and referenced by `task_runs.trajectory_blob`. Field-level structure:

```json
{
  "trajectory_version": 1,
  "task_run_id": "01J8Z...",
  "run_id": "01J8Y...",
  "task_id": "fix-null-deref",
  "task_content_hash": "9f8e...",
  "seed": "5f2a9c01d4e8b7a3",
  "adapter": {"id": "adapter-simulated", "version": "1.0.0",
              "contract": "assay-adapter/1", "tier": "full"},
  "model": {"provider": "synthetic", "model": "scripted-v1",
            "family": "synthetic"},
  "complete": true,
  "truncation": null,
  "turns": [
    {
      "turn_index": 0,
      "alignment_key": "t0:m:req-1:a3b1...",
      "request": {"request_id": "req-1", "message_count": 2,
                  "input_summary_sha256": "c4d2..."},
      "response": {"status": "ok", "stop_reason": "tool_use",
                   "latency_ms": 412, "text": null},
      "tool_calls": [
        {"call_id": "c-1", "call_index": 0, "tool": "read_file",
         "semantic_class": "read", "args_sha256": "a3b1...",
         "args": {"path": "src/main.ts"},
         "result": {"status": "ok", "duration_ms": 8,
                    "result_sha256": "77aa...", "result": "…"}}
      ],
      "usage": {"prompt_tokens": 812, "completion_tokens": 64,
                "total_tokens": 876, "cost_usd_micros": 0,
                "source": "synthetic", "reconciled": true}
    }
  ],
  "text_outputs": [{"after_turn": 1, "text": "Fixed the null deref."}],
  "terminal": {"type": "run_completed", "summary": "Patched and tested."},
  "totals": {"turns": 2, "tool_calls": 3, "prompt_tokens": 1930,
             "completion_tokens": 210, "total_tokens": 2140,
             "cost_usd_micros": 0, "wall_clock_ms": 1873},
  "redaction": {"ruleset_version": "2026.08", "applied": []}
}
```

### 8.2 Validation rules

- `trajectory_version` (integer, required): 1. A metric definition change
  bumps metric versions, not this field (FR-TRAJ-008); this field changes
  only when the record shape changes.
- `complete` (boolean, required): false whenever any §6 pairing rule was
  violated, a malformed frame occurred, or termination was abnormal.
- `truncation` (object or null): when non-null, `{reason, last_seq}` with
  `reason` in `cancelled | timed_out | harness_crash | protocol_error`
  (FR-TRAJ-009).
- `turns[].turn_index`: dense, 0-based, strictly increasing.
- Every `tool_calls[]` entry pairs a call and its result or carries
  `"result": null` with `complete: false` at the record level.
- `usage.reconciled` reflects the per-request ADR-0009 check; any false
  value forces the run's budget summaries to fail closed.
- All hashes are of canonical JSON (args) or raw bytes (results); the
  `args_sha256` in the record equals `tool_calls.args_sha256` in SQLite —
  divergence is `internal_invariant` at persist time.
- Identical inputs (scenario, seed, injected clock) produce byte-identical
  trajectory blobs; the equality is asserted in golden tests, which are
  regenerated only by explicit command with semantic review
  (FR-TRAJ-002, NFR-MAINT-005).

### 8.3 Alignment keys

`alignment_key` exists so two trajectories of the same task diff
turn-by-turn (FR-TRAJ-011). Format:

```text
t<turn_index>:<kind>:<anchor>:<content_prefix>
```

- `kind`: `m` (model exchange) or `x` (text output).
- `anchor`: the request's ordinal position among requests (not the
  adapter-chosen `request_id`, which need not match across runs).
- `content_prefix`: first 8 hex chars of the sha256 over the ordered list
  of `(tool, args_sha256)` pairs in the turn, or of the response text hash
  for tool-free turns.

Keys are computed by `packages/trajectory` at capture, stored on `turns`,
and consumed by the viewer diff (§11.3); the viewer never invents its own.

### 8.4 Redaction manifest

`redaction.applied` lists every redaction event:

```json
{"rule_id": "pem-block", "ruleset_version": "2026.08",
 "location": "/turns/3/tool_calls/0/result",
 "replacement": "[REDACTED:pem-block:1]", "count": 1}
```

- `location` is an RFC 6901 JSON Pointer into this record.
- Entropy-scanner hits use `rule_id: "entropy"` with the token length
  recorded, never the token.
- The manifest lists defensive harness truncations (§6.1) under
  `rule_id: "truncation"`.
- An empty `applied` array is a positive statement that scanning ran and
  found nothing; absence of the `redaction` object is invalid and blocks
  persistence (`redaction_failed`, fail-closed per ADR-0010).

## 9. Statistics, judge, and budget engines

### 9.1 Common design: pure cores, injected effects

All three engines are pure-function cores. They accept plain values plus
injected `SeedSource` and `Clock`; they perform no I/O, read no env, and
log nothing. This is what makes them mutation-testable and property-
testable: mutation testing gates `packages/stats` and
`packages/trajectory` at ≥ 85% mutation score (NFR-MAINT-002), and the
mutation surface is precisely these pure modules — a survived mutant in
interval math is a real hole, not noise from I/O scaffolding.

### 9.2 Statistics engine module map

Every METHODOLOGY.md formula lives in exactly one module of
`packages/stats`; METHODOLOGY's published power/MDE tables are generated
by this same code (FR-STAT-012), so document and gate cannot drift.

| Module | Formula owned | Constants |
| --- | --- | --- |
| `wilson.ts` | 95% Wilson score interval per task pass rate | z for alpha 0.05 two-sided |
| `newcombe.ts` | Newcombe hybrid score interval for per-task deltas | 95% |
| `boschloo.ts` | Two-sided Boschloo exact test per task | alpha 0.05 |
| `fisher.ts` | Fisher exact fallback (documented fallback implementation) | alpha 0.05 |
| `bootstrap.ts` | Suite-level delta: stratified paired-by-task bootstrap, BCa, B = 10,000, seeded | seed recorded in the report (FR-STAT-009) |
| `bh.ts` | Benjamini–Hochberg FDR across per-task tests in one comparison | q = 0.05; raw and adjusted values both surfaced (FR-STAT-004) |
| `mde.ts` | Minimum detectable effect for the actual n used; power target 0.8 | default n = 10; minimum n = 5 for any comparative wording stronger than "insufficient data" |
| `flake.ts` | always_pass (k=n), always_fail (k=0), unstable (0<k<n); genuinely-unstable requires the Wilson CI to exclude 0 and 1 at n ≥ 10 | — |
| `pairing.ts` | Comparison pairing: identical task content hashes only; drift aborts with `comparison_invalid` (FR-STAT-010) | — |

The `Comparator` (master interface) composes these: pair → per-task tests
→ BH adjustment → bootstrap suite delta → MDE statement → verdict inputs.
It returns a `ComparisonReport` value; it never prints, never persists,
never words the verdict (reporting owns wording, §10.2).

### 9.3 Judge engine

`packages/judge` composes four pure stages plus one provider call:

1. **Rubric resolution** — rubric file, version, and its calibration row;
   a judge assertion without both was already rejected at load
   (FR-ASSERT-006); a rubric changed since calibration invalidates the
   agreement (`judge_uncalibrated`, FR-JUDGE-010).
2. **Isolation transform** — subject output enters the judge prompt only
   inside delimited, provenance-labeled blocks with instruction stripping
   as specified in METHODOLOGY.md §judge (FR-JUDGE-006). The transform is
   a pure function with adversarial fixtures from the red-team corpus
   (NFR-SEC-003).
3. **Vote collection** — k = 3 calls through `packages/providers`, each
   cost-accounted and budget-gated like any provider call (FR-JUDGE-008).
4. **Aggregation** — majority verdict with the full vote distribution
   stored (FR-JUDGE-009); agreement metadata (percent agreement, Cohen's
   kappa) attached to the verdict everywhere it renders (FR-ASSERT-007);
   kappa ≥ 0.6 required to gate, else advisory-only (FR-JUDGE-004);
   same-family judging only under `allow_same_family_judge: true`, flagged
   in every report containing the result (FR-JUDGE-005).

`assay judge calibrate <rubric>` runs stage 2–3 over the ≥ 50-item
human-labeled calibration set (FR-JUDGE-002) and writes the `calibrations`
row; agreement math (kappa) is a pure module under the mutation gate.

### 9.4 Budget engine

`packages/budgets` implements `BudgetEvaluator.evaluate(summaries,
budgets)` as a pure fold:

1. Reject any summary with unreconciled usage for dollar/token budgets:
   the affected budget verdict is `breach` with cause
   `usage_unreconciled` (fail closed, FR-BUD-003).
2. Compute the declared statistic (median or p95) per budgeted dimension
   across the n runs (FR-BUD-004): total tokens, wall-clock ms, tool-call
   count, micro-USD.
3. Compare against per-task then per-suite declarations; any breach
   yields a `BudgetVerdict` with per-dimension rows, distinct from
   assertion failure (FR-BUD-002), driving exit code 2.
4. Latency rows separate provider latency (adapter-reported
   `latency_ms`), tool latency (`tool_result.duration_ms` sums), and
   harness overhead (measured between injected-clock marks; the p95
   overhead budget of < 2 s is NFR-COST-005's own gate).

The runaway guard is the only impure neighbor: a small stateful
accumulator in the scheduler that folds projected spend after every task
run and aborts the suite at the declared dollar ceiling (FR-BUD-008,
NFR-COST-004). Its threshold math is pure and mutation-tested.

## 10. Reporting

### 10.1 Delta-table structure

`assay compare <baseline> <candidate> [--threshold T]` renders one delta
table, identical in md and json modulo format. Columns, in order:

| Column | Content | Source |
| --- | --- | --- |
| Task | task id | pairing (identical content hashes only) |
| Baseline | k/n with 95% Wilson CI | aggregation |
| Candidate | k/n with 95% Wilson CI | aggregation |
| Delta | point delta with Newcombe hybrid CI | `newcombe.ts` |
| Test | test name actually used (`boschloo` or `fisher`) | `boschloo.ts`/`fisher.ts` (FR-STAT-003) |
| p / q | raw p and BH-adjusted q | `bh.ts` (FR-STAT-004) |
| Flake | flake class per variant | `flake.ts` (FR-STAT-006) |
| Cost | median and p95 micro-USD per variant, delta | budget summaries |
| Verdict | per-task wording-contract phrase | §10.2 |

Footer rows: suite-level bootstrap delta with BCa CI and recorded seed
(FR-STAT-009); the MDE statement for the actual n (FR-STAT-005); the
isolation labels of both runs; any `unsafe_host` or same-family-judge
banner; quarantined or cancelled runs excluded, named.

### 10.2 Wording-contract enforcement point

`packages/reporting` exports one function:

```ts
export function renderVerdictPhrase(v: ComparisonVerdict): VerdictPhrase;

export type VerdictPhrase =
  | { readonly kind: "regression_detected" }
  | { readonly kind: "improvement_detected" }
  | { readonly kind: "no_significant_difference"; readonly mdeMillis: number }
  | { readonly kind: "insufficient_data"; readonly minimumN: 5 };
```

Every surface — CLI output, md report, json report, PR comment, viewer —
renders verdict language through this function and nothing else
(FR-STAT-007). A grep-based CI check asserts the four phrase literals
appear in exactly one source file. `insufficient_data` is forced whenever
any compared task has n < 5, regardless of what the tests would say.

### 10.3 Renderers

- `md`: GitHub-flavored table for humans and the Action's PR comment; the
  comment carries an idempotency marker so the Action updates one comment
  per PR (FR-CI-002).
- `json`: the full `ComparisonReport` under a versioned envelope
  (`report_version: 1`), canonical JSON, suitable for the status-check
  threshold logic (FR-CI-003) and archival diffing.
- `assay report <run> --format md|json` renders a single run without
  comparison: per-task rates with Wilson CIs (FR-STAT-002), budget rows,
  assertion summaries, trajectory metric summaries. Single-run output
  never contains comparative language at all — statistics-or-silence.

## 11. Viewer architecture (ADR-0011)

### 11.1 Server

`assay view [--port P]` starts a loopback-only, read-only HTTP server:

- binds `127.0.0.1` exclusively; refuses to start on `0.0.0.0`
  (NFR-SEC-005);
- generates a per-session random token, embeds it in the printed URL
  (`http://127.0.0.1:P/#t=<token>`), and rejects any request without it;
- serves the SPA bundle from harness assets — built at Assay build time,
  no CDN, no telemetry, no external request of any kind;
- exposes only GET routes; no mutation endpoint exists in the code, not
  merely in the router (FR-TRACE-008): the handler set is constructed
  from `run-store` read-only queries alone.

Route table:

| Route | Returns |
| --- | --- |
| `GET /api/runs?query…` | run summaries (list/filter, FR-TRACE-002) |
| `GET /api/runs/:runId` | run record and aggregation |
| `GET /api/task-runs/:taskRunId` | task-run record with assertions, metrics, budgets |
| `GET /api/task-runs/:taskRunId/trajectory` | trajectory JSON (redacted at capture; nothing to re-redact) |
| `GET /api/blobs/:sha256` | blob bytes, hash-verified on read |
| `GET /api/compare/:comparisonId` | stored comparison report |
| `GET /api/diff?left=:taskRunId&right=:taskRunId` | precomputed diff structure (§11.3) |

### 11.2 SPA structure

React + Vite, bundled at build time. Views: run list → run detail (delta
and budget rows) → task-run detail (turn timeline with tool calls,
metrics, assertion results, judge votes with agreement metadata,
FR-TRACE-004) → diff view. State is URL-addressed so a view is shareable
between local tabs; no client-side persistence beyond the token.

### 11.3 Diff algorithm

Inputs: two task runs of the same `task_id` and `task_content_hash`
(enforced server-side; mismatch is `comparison_invalid`).

1. Load both turn sequences with their stored alignment keys (§8.3).
2. Align by longest common subsequence over alignment keys, comparing
   keys in three tiers: exact key match; then anchor match (`t<i>:<kind>:
   <anchor>`) with differing content prefixes — an "aligned but changed"
   turn; then unmatched — inserted/deleted turns.
3. First divergence = the lowest turn index whose pair is not an exact
   key match (FR-TRACE-005, FR-TRAJ-011). Ties cannot occur: indexes are
   dense and scanning is in order.
4. Within an aligned-but-changed pair, diff tool calls by
   `(tool, call_index)` and mark the first differing `args_sha256` or
   result status; text responses diff by line.
5. Edge cases: differing turn counts diff to the shorter length plus
   trailing insertions; an incomplete trajectory renders its truncation
   marker as the divergence boundary when divergence is not found before
   it; two byte-identical trajectories report "no divergence" and the UI
   says so rather than showing an empty diff.

### 11.4 Performance budget

A 200-turn trajectory renders in p95 < 1 s from the local store
(NFR-COST-006). Design consequences: the diff is computed server-side
from indexed rows (`turns`, `tool_calls`), not by shipping two full
trajectory blobs to the browser; the turn timeline virtualizes; blob
fetches are lazy per expanded turn. The budget is enforced by a
performance test in the viewer's gate (R9), not by intent.

## 12. Configuration architecture

### 12.1 Schema

```ts
export interface AssayConfig {
  readonly configVersion: 1;
  readonly concurrency: number;          // default 4, 1..64
  readonly runsPerTask: number;          // default 10, min 1
  readonly defaultAdapter: string;       // default "adapter-simulated"
  readonly storePath: string;            // default ".assay"
  readonly sandbox: {
    readonly socketPath: string | null;  // null = platform default
    readonly defaultCpus: number;        // default 2
    readonly defaultMemoryMib: number;   // default 2048
    readonly defaultPids: number;        // default 256
    readonly defaultDiskMib: number;     // default 1024
    readonly defaultWallClockMs: number; // default 600000
  };
  readonly budgets: {
    readonly suiteUsdCeilingMicros: number | null; // null = no paid runs
  };
  readonly comparison: {
    readonly threshold: number;          // status-check threshold, ×1000
    readonly baseline: string | null;    // branch, tag, or run id (FR-CI-006)
  };
  readonly viewer: { readonly port: number };  // default 0 = ephemeral
  readonly redaction: { readonly rulesetVersion: string };
  readonly pricingCatalogVersion: string;
}
```

Secrets are not configuration: BYOK credentials are env/OS-keychain
references resolved at spawn time and never appear in this schema, in
files, or in the store (NFR-SEC-004).

### 12.2 Precedence and validation order

Precedence: CLI flags > `ASSAY_*` env > project `assay.config.yaml` >
built-in defaults. Env mapping is mechanical
(`ASSAY_CONCURRENCY` → `concurrency`, `ASSAY_SANDBOX_SOCKET_PATH` →
`sandbox.socketPath`), documented exhaustively in the schema.

Startup validation order, failing fast at the first violation with the
offending source named:

1. Parse argv (unknown flag → `invalid_invocation`).
2. Read env through the injected accessor; unknown `ASSAY_*` keys →
   `invalid_configuration`.
3. Parse `assay.config.yaml` if present; unknown keys, wrong types, or
   unknown `configVersion` → `invalid_configuration`.
4. Merge by precedence into `ResolvedConfig`; record per-field source.
5. Cross-field checks: `runsPerTask ≥ 1`; a declared dollar budget with a
   null suite ceiling is rejected (the runaway guard must have a ceiling
   to enforce); `--unsafe-host-exec` combined with a task-declared
   network allowlist is rejected (no proxy exists to enforce it).
6. Hash the canonical form for the run record (`config_hash`).

## 13. Concurrency and cancellation model

### 13.1 AbortSignal propagation tree

```text
process signals (SIGINT/SIGTERM)
  -> root AbortController (apps/cli)
       -> suite controller (assay run)
            -> scheduler
                 -> task-run controller × concurrency
                      -> sandbox operations (create/exec/snapshot)
                      -> adapter subprocess lifetime
                      -> per-assertion evaluation
                      -> judge provider calls
       -> viewer server lifetime (assay view)
       -> comparison computation (assay compare)
```

Every async operation in every package takes an `AbortSignal` parameter
(visible in the §6.8 and master interfaces). No package installs its own
process signal handler; only `apps/cli` does.

### 13.2 Signal handling

- First SIGINT/SIGTERM: abort the root controller. The scheduler stops
  admitting; task runs settle per §3.7; terminal `cancelled` states
  persist (FR-RUN-006); the reaper runs; exit code 6.
- Second signal within the grace window: skip settling, SIGKILL all
  adapter processes, force-remove labeled containers, exit 6. The store
  may hold nonterminal records; §4.4 recovery owns them on next start.
- SIGKILL of the harness itself: no handler runs by definition; §4.4 and
  the on-start reaper are the recovery story (FR-RUN-011).

### 13.3 Bounded parallelism

- One semaphore of width `concurrency` gates task-run admission
  (FR-RUN-005); there are no nested unbounded spawns — judge votes for
  one task run execute sequentially, and per-run assertion evaluation is
  sequential by declared order (FR-ASSERT-002).
- Each task-run pipeline owns its collector, sandbox handle, and
  trajectory builder exclusively; no shared mutable state exists between
  pipelines except the store writer (serialized by transaction) and the
  runaway-spend accumulator (a single-owner fold in the scheduler).
- Backpressure: the adapter stdout reader applies flow control; if the
  redaction/validation stage falls behind the 256 MiB stream budget
  boundary, collection fails deterministically rather than buffering
  unboundedly.

### 13.4 Cleanup ordering

On any task-run settlement (success, failure, timeout, cancel), in order:

1. Stop reading adapter stdout; close stdin.
2. Terminate the adapter (SIGTERM, 5 s, SIGKILL); reap the process.
3. Take the workspace snapshot if the state machine still permits it.
4. Destroy the sandbox (`destroy()` idempotent, always attempted).
5. Persist the terminal record in one transaction.
6. Release the semaphore permit.

Order matters: the snapshot precedes destruction; persistence precedes
permit release so the runaway accumulator folds a durable number; the
permit is released even when persistence fails (the failure is recorded
via recovery, and holding permits would deadlock the scheduler's drain).

## 14. Cross-cutting concerns

### 14.1 Error taxonomy placement

The stable category enum lives in `packages/contracts` and is the only
error vocabulary that crosses a package boundary: `invalid_invocation`,
`invalid_configuration`, `task_invalid`, `suite_invalid`,
`checker_invalid`, `fixture_unavailable`, `fixture_hash_mismatch`,
`adapter_unavailable`, `adapter_protocol_error`, `adapter_nonconformant`,
`sandbox_unavailable`, `sandbox_start_failed`, `sandbox_limit_exceeded`,
`sandbox_timeout`, `provider_authentication`, `provider_rate_limit`,
`provider_transient`, `provider_invalid_response`, `usage_unreconciled`,
`assertion_error`, `judge_unavailable`, `judge_uncalibrated`,
`budget_exceeded`, `comparison_invalid`, `storage_locked`,
`storage_corrupt`, `storage_migration_required`, `redaction_failed`,
`cancelled`, `internal_invariant`.

Every thrown error is an `AssayError { category, message, cause? }`
constructed at the boundary where the failure is first classified; raw
thrown objects never cross a package boundary. `apps/cli` maps categories
to exit codes (§3.10); reports render categories verbatim so a CI log and
a report row always agree.

### 14.2 Injected clocks, IDs, and seeds

`packages/contracts` defines `Clock` (monotonic + wall), `IdSource`
(ULIDs), and `SeedSource` (seeded PRNG streams). `apps/cli` constructs
real implementations once; tests and golden fixtures construct fixed ones
(NFR-DET-002, NFR-DET-003). No package calls `Date.now`,
`crypto.randomUUID`, or `Math.random`; a lint rule bans the identifiers
outside the composition root and the platform implementations.

### 14.3 Logging discipline

- stdout carries exactly the selected command output (report, table,
  plan); nothing else, ever.
- Diagnostics go to stderr as structured lines through `DiagnosticSink`,
  which applies redaction before any byte leaves the process — the same
  fail-closed engine as capture (ADR-0010, NFR-SEC-001).
- No secret appears in argv, config files, logs, traces, reports, or
  bundles; the planted-credential corpus exercises every sink.
- Log level is configuration; verbosity never changes semantics or exit
  codes.

### 14.4 `AssayEvent`: the single observability contract

The versioned event union in `packages/contracts` is the one vocabulary
every surface consumes — CLI progress rendering, diagnostics, the store's
durable record, and future machine output. Minimum members: `RunPlanned`,
`FixtureMaterialized`, `SandboxStarted`, `AdapterHandshake`,
`ModelRequestStarted`, `ModelResponseRecorded`, `ToolCallRecorded`,
`UsageReconciled`, `UsageUnreconciled`, `WorkspaceSnapshotTaken`,
`AssertionEvaluated`, `JudgeVoteRecorded`, `TrajectoryScored`,
`BudgetEvaluated`, `TaskRunCompleted`, `SandboxDestroyed`,
`SuiteCompleted`, `ComparisonCompleted`, `RunFailed`, `RunCancelled`.

Rules: every event carries `run_id`, `task_run_id` where applicable,
injected timestamps, and a schema version; renderers consume events, not
internal state; a subsystem that cannot express a fact as an `AssayEvent`
does not get to display it. The union is a versioned public contract
before 1.0 (NFR-MAINT-003), and §3/§4 name the emission point of every
member so an event can never appear without its owning transition.

## 15. Explicit deferrals and requirements traced

### 15.1 Explicit deferrals

Deferred, with the phase boundary stated; deferred items are forbidden as
completion evidence, and undecided questions live only in
OPEN_QUESTIONS.md with fail-closed defaults and reopen triggers:

- Hosted or multi-tenant anything, prompt playgrounds, dataset labeling,
  observability-platform features: out of scope for 1.0 per ADR-0002.
- Sequential/anytime statistics and Bayesian comparison: rejected in
  ADR-0006, not merely deferred; reopening requires a new ADR.
- Firecracker/nsjail isolation backends: rejected in ADR-0004 for
  platform coverage; a Linux-only hardened backend would be a post-1.0
  ADR.
- Adapter SDKs in languages other than TypeScript: the JSONL contract is
  language-neutral by design; shipped SDK helpers beyond TS are post-1.0.
- Contract minor `assay-adapter/1.1` stdin cancel frame (§6.3): reserved,
  not designed here.
- Telemetry of any kind: none exists in 1.0 (NFR-PRIV-006).
- Viewer write features (annotations, labels): excluded by FR-TRACE-008;
  any future mutation surface is a new ADR, not a route addition.

### 15.2 Requirements traced

| Section | Realizes |
| --- | --- |
| §1 Objective and constraints | NFR-DET-001..004, NFR-COST-001, NFR-PRIV-001, NFR-PRIV-006 |
| §2 Component boundaries | NFR-MAINT-001, NFR-MAINT-003, NFR-MAINT-006, NFR-SEC-006 |
| §3 Execution model | FR-RUN-001..012, FR-TASK-001..010, FR-ASSERT-001..010, NFR-COST-003 |
| §4 State machine | FR-RUN-002, FR-RUN-003, FR-RUN-009, FR-RUN-011, FR-TRAJ-009 |
| §5 Sandbox | FR-SAND-001..012, FR-BUD-007, NFR-SEC-002, NFR-SEC-007, NFR-COST-005 |
| §6 Adapter interface | FR-ADAPT-001..010, FR-TRAJ-005, FR-TRAJ-010, FR-TRAJ-012, NFR-DET-005 |
| §7 Storage | FR-TRACE-001, FR-TRACE-002, FR-TRACE-006, FR-TRACE-007, FR-TRACE-009, FR-TRACE-010 |
| §8 Trajectory record | FR-TRAJ-001..011, NFR-PRIV-002 |
| §9 Engines | FR-STAT-001..012, FR-JUDGE-001..010, FR-BUD-001..008, NFR-MAINT-002, NFR-SEC-003 |
| §10 Reporting | FR-STAT-002..007, FR-BUD-002, FR-CI-002, FR-CI-003 |
| §11 Viewer | FR-TRACE-003..005, FR-TRACE-008, NFR-SEC-005, NFR-COST-006 |
| §12 Configuration | FR-CI-006, NFR-SEC-004, plus the §7 CLI config precedence contract |
| §13 Concurrency | FR-RUN-005, FR-RUN-006, FR-SAND-006, FR-SAND-012, NFR-COST-004 |
| §14 Cross-cutting | NFR-DET-002, NFR-DET-003, NFR-SEC-001, NFR-MAINT-003, NFR-PRIV-004 |

Requirements owned primarily by other documents — the GitHub Action's
operational details (FR-CI-001, FR-CI-004, FR-CI-005, FR-CI-007,
FR-CI-008, NFR-SEC-008), format migration mechanics (FR-TASK-011,
FR-TASK-012), recorded-provider fixtures (NFR-DET-006), paid-smoke
ceilings (NFR-COST-002), export/retention behavior (NFR-PRIV-003,
NFR-PRIV-005), and golden-fixture regeneration policy (NFR-MAINT-005) —
are architecturally constrained here (§2, §3.4, §7.2, §7.5, §14) and
terminally specified in PRODUCT_REQUIREMENTS.md, OPERATIONS_TEST_PLAN.md,
and PRIVACY_AND_DATA.md. Every FR/NFR namespace in the register appears in
this table or that list; the BUILD_PLAN traceability matrix maps each
individual ID to its owning gate and evidence.
