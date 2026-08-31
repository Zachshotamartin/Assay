# Assay Agent Compatibility and Adapter Conformance

Document status: planned — normative for adapter conformance details. Where
this document conflicts with an accepted ADR, PRODUCT_REQUIREMENTS.md,
METHODOLOGY.md, BUILD_PLAN.md, ARCHITECTURE.md, or TASK_FORMAT.md, those
documents control, in that order.

Last revised: 2026-08-30.

> Assay is under implementation. Gate R0 is accepted with repository,
> toolchain, CI, and GitHub governance evidence. Gates R1 through R10 remain
> planned. No product gate beyond the repository substrate is accepted.

Assay evaluates coding and tool-using agents. An agent participates in an
evaluation through an **adapter**: a subprocess that speaks the versioned
`assay-adapter/1` contract defined here. Assay owns this contract outright
(ADR-0005). It does not import any subject agent's provider abstraction,
protocol library, or internal packages, and no adapter links into the harness
process. This document defines the contract, the conformance tiers Assay
assigns, the conformance suite that assigns them, the two in-plan adapters
(simulated and Robin), and the checklist for writing a new one.

## 1. Exact compatibility goal

An arbitrary agent binary is not automatically evaluable. Assay's
compatibility promise is bounded and testable:

1. Any agent for which a conforming adapter exists can be run by `assay run`
   inside the sandbox, scored by the assertion layers its conformance tier
   permits, and compared across variants by the statistics engine.
2. A new agent can be added by writing an adapter subprocess only. Adding an
   adapter never changes the runner, the assertion engines, the trajectory
   metrics, the budget evaluator, the statistics package, the trace store, or
   the report formats.
3. The measurements Assay reports for an agent are exactly the measurements
   its adapter's conformance tier proves it can deliver. A tier is assigned by
   the conformance suite in section 4, never self-asserted by the adapter.
4. An agent whose adapter cannot or does not emit the event stream can still
   be evaluated in the black-box tier: Assay observes the sandbox workspace
   before and after the run plus the exit status, and every report states the
   resulting measurement limits.
5. No adapter can widen its claims by configuration. Declaring a capability
   flag the conformance suite disproves demotes the adapter, and the demotion
   is recorded in every report that includes its runs.

"Any agent" therefore means: any agent behind an adapter with a recorded
conformance result, at the tier that result assigns. It never means that
pointing Assay at an unknown executable produces trajectory metrics, cost
accounting, or statistical comparisons of them. That restriction is the
compatibility claim, not a caveat to it.

## 2. The `assay-adapter/1` contract

### 2.1 Subprocess model

An adapter is an executable. For each task run attempt, the harness:

1. materializes the task fixture into a sandbox workspace (ADR-0004);
2. spawns the adapter process inside that sandbox, subject to the task's
   isolation policy — network, CPU, memory, pids, and wall-clock limits apply
   to the adapter and every child it spawns (FR-ADAPT-009);
3. writes exactly one run-spec JSON document to the adapter's stdin and
   closes stdin;
4. reads newline-delimited JSON event frames from stdout and a bounded
   diagnostic stream from stderr;
5. waits for process exit, then snapshots the workspace for assertions.

One adapter process serves exactly one task run attempt. There is no
long-lived adapter daemon, no multiplexing of runs over one process, and no
harness-to-adapter channel other than the initial stdin document and POSIX
signals. This keeps the trust boundary a process boundary: a misbehaving
adapter can waste its own sandbox, and nothing else.

### 2.2 Spawn contract

**argv.** The adapter command line comes verbatim from the suite or variant
configuration (`adapter.command`, an argv array). The harness appends exactly
one argument: `--assay-adapter`. It never appends task data, prompts, seeds,
paths, or credentials to argv; all run data travels on stdin. Nothing
secret may ever appear in argv (NFR-SEC-001).

**Environment allowlist.** The adapter environment is constructed, not
inherited. It contains exactly:

- `ASSAY_ADAPTER_CONTRACT=assay-adapter/1` — the contract the harness speaks;
- `PATH`, `HOME`, `TMPDIR` — as provided by the sandbox image, pointing only
  at container-private locations;
- `LANG=C.UTF-8` and `LC_ALL=C.UTF-8` — fixed for deterministic text handling;
- task-declared environment variables (FR-SAND-004);
- credential variables the task explicitly declares, resolved at spawn time
  from environment or OS-keychain references and never persisted by Assay
  (NFR-SEC-004).

No other harness-host variable crosses the boundary. The harness snapshots
the constructed environment (after redaction, ADR-0010) into the run record.

**Working directory.** The adapter starts in the sandbox workspace root: the
directory where the fixture was materialized and where the agent is expected
to do its work. The workspace path is also present in the run spec as
`workspace_path`; the two must agree, and the adapter must treat that
directory as the only writable project surface.

**stdin.** One UTF-8 JSON document — the run spec (section 2.3) — followed by
end-of-file. The harness writes it and closes the pipe before reading any
stdout frame. An adapter must not block waiting for further stdin input.

**stdout.** Reserved exclusively for JSONL event frames under the framing
rules in section 2.4. Any child process output the adapter wants to surface
must be wrapped in `log` or `tool_result` frames; raw passthrough of child
stdout onto the adapter's stdout is a protocol violation.

**stderr.** Free-form diagnostics. The harness captures at most 262,144 bytes
(256 KiB) of stderr per run, retains the head, records the count of dropped
bytes, redacts the capture at the boundary (ADR-0010), and stores it as a
diagnostic blob. stderr is never parsed for results and never influences
scoring (FR-ADAPT-005).

### 2.3 Run spec document

The single stdin document has this schema. Unknown top-level fields are a
spec error and the adapter must exit with code 2 (section 2.8) without
emitting a `session_started` frame.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `contract_version` | string | yes | Exactly `"assay-adapter/1"`. |
| `contract_minor` | integer | yes | Harness minor revision, `>= 0`. |
| `run_id` | string | yes | Opaque harness identifier, 1–128 chars. |
| `task_id` | string | yes | Task id per TASK_FORMAT.md (FR-TASK-012). |
| `attempt` | integer | yes | 1-based index within the task's n runs. |
| `seed` | integer | yes | Recorded run seed (NFR-DET-002); adapters that can honor it must; adapters that cannot must say so via `capabilities.deterministic`. |
| `prompt` | string | yes | The task prompt, 1–262,144 bytes. |
| `workspace_path` | string | yes | Absolute path of the sandbox workspace. |
| `timeout_ms` | integer | yes | Harness-side wall-clock budget hint; the harness enforces its own monotonic timer regardless (FR-RUN-008). |
| `agent_config` | object | no | Opaque adapter-specific configuration from the variant, canonical JSON, at most 65,536 bytes. The harness never interprets it. |

Validation failures of the run spec on the adapter side are reported by exit
code 2 plus a stderr diagnostic; the harness classifies the run as
`adapter_protocol_error` in the infrastructure category, never as a task
failure (FR-RUN-003).

### 2.4 Framing rules

1. A frame is one JSON object serialized on one line, terminated by `\n`
   (LF). No pretty-printing, no carriage returns inside the framing, no BOM.
2. Encoding is UTF-8. Invalid UTF-8 in the stream is a protocol error for the
   frame in which it occurs.
3. Maximum frame size is 1,048,576 bytes (1 MiB) including the terminator. An
   oversized frame is rejected without being parsed.
4. Every frame carries the common fields in section 2.5. `seq` starts at 1
   and increments by exactly 1 per frame; a gap, repeat, or decrease is a
   protocol error.
5. A frame whose `type` is unknown to the harness but whose major contract
   version matched at handshake is ignored-with-count: the harness skips it,
   increments a per-run `unknown_frame_count`, and reports the count. Unknown
   frame types at an unknown major version never arise, because an unknown
   major is rejected at handshake (section 2.9) before events are read.
6. A line that fails to parse as JSON, an oversized frame, or a frame failing
   its schema is counted in `malformed_frame_count` and captured (bounded,
   redacted) as evidence. Malformed frames never crash the harness
   (FR-ADAPT-005). The run's handling depends on which frame was malformed:
   a malformed handshake or terminal frame fails the run with
   `adapter_protocol_error`; any other malformed frame marks the trajectory
   incomplete (FR-TRAJ-005) and is reported.
7. Every frame is redacted at the capture boundary before persistence
   (ADR-0010, FR-TRAJ-007). A frame that cannot be redacted is not persisted,
   and the run fails with `redaction_failed`.

### 2.5 Common frame fields

Every frame, including the handshake, carries:

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `type` | string | yes | One of the frame types defined in this section, or an unknown type handled per rule 5 above. |
| `seq` | integer | yes | Strictly increasing from 1 by steps of 1. |
| `ts` | string | yes | ISO 8601 UTC timestamp with millisecond precision, from the adapter's clock. Informative only: harness-side monotonic receive times are authoritative for all latency accounting (FR-BUD-006, FR-RUN-008). |

### 2.6 Handshake frame

`type: "handshake"`. Must be the first frame on stdout, emitted within
10,000 ms of spawn (harness clock). A first frame of any other type, or
handshake absence at the deadline, fails the run with
`adapter_protocol_error` — except that a black-box registration (section 3)
declares up front that no stream will come, so no handshake is awaited.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `contract_version` | string | yes | Pattern `assay-adapter/<major>`; major is a positive integer. Section 2.9 defines negotiation. |
| `contract_minor` | integer | yes | `>= 0`. |
| `adapter` | object | yes | Fields below. |
| `adapter.id` | string | yes | Stable adapter identifier, 1–64 chars, `[a-z0-9-]`. |
| `adapter.version` | string | yes | Adapter semver string. |
| `agent` | object | yes | Identity of the subject under test. |
| `agent.id` | string | yes | Stable agent identifier, 1–64 chars. |
| `agent.version` | string | yes | Exact agent version, tag, or commit as pinned by the adapter. |
| `agent.executable_digest` | string | no | `sha256:<hex>` of the agent entry point when the adapter can compute it. |
| `model` | object or null | yes | Model identity when known at spawn (FR-ADAPT-008); null when the agent selects models per request, in which case every `model_request` must carry it. |
| `model.provider` | string | cond. | Required when `model` is non-null. `synthetic` is a valid provider (ADR-0009). |
| `model.model_id` | string | cond. | Required when `model` is non-null. Exact configured identifier, never an alias resolved silently. |
| `tools` | array | yes | Tool catalog; may be empty only when `capabilities.emits_tool_events` is false. |
| `tools[].name` | string | yes | Unique within the catalog, 1–128 chars. |
| `tools[].semantic_class` | string | yes | One of `read`, `write`, `execute`. A tool that does not cleanly fit must be declared `execute`, the most conservative class. Trajectory metrics such as read-before-write discipline are computed from these classes (FR-TRAJ-010, FR-ADAPT-006). |
| `tools[].description` | string | no | At most 1,024 bytes. |
| `capabilities` | object | yes | Boolean flags below; all required. |
| `capabilities.emits_tool_events` | boolean | yes | Adapter emits `tool_call`/`tool_result` frames. |
| `capabilities.reports_usage` | boolean | yes | Adapter emits a `usage` frame per model request (FR-ADAPT-008). |
| `capabilities.reports_cost` | boolean | yes | `usage` frames include provider-reported dollar cost. |
| `capabilities.supports_cancellation` | boolean | yes | Adapter terminates cleanly within the grace period after SIGTERM. |
| `capabilities.deterministic` | boolean | yes | Same run spec and seed reproduce the same event stream byte-for-byte after timestamp normalization. |

Capability flags set a tier ceiling; the conformance suite sets the tier
(section 3). A flag the suite disproves is recorded as a conformance defect.

### 2.7 Event frames

#### session_started

Second frame, exactly once, after the handshake.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `session_id` | string | yes | Adapter-scoped identifier for this run, 1–128 chars. |
| `task_id` | string | yes | Must echo the run spec `task_id`. |
| `attempt` | integer | yes | Must echo the run spec `attempt`. |
| `seed_honored` | boolean | yes | Whether the run spec seed was applied to the agent. Must be consistent with `capabilities.deterministic`. |

#### model_request

One frame per outbound model call, before its response.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `request_id` | string | yes | Unique within the run, 1–128 chars. |
| `turn` | integer | yes | 1-based agent turn index; non-decreasing across the run. |
| `model` | object | cond. | Required when the handshake `model` was null; same schema as the handshake field. When present it overrides the handshake identity for this request only. |
| `input_digest` | string | yes | `sha256:<hex>` of the canonical serialized request the adapter sent or observed. |
| `input_bytes` | integer | yes | Size of that serialization, `>= 0`. |

#### model_response

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `request_id` | string | yes | Must match an open `model_request`; exactly one response per request. |
| `stop_reason` | string | yes | One of `end_turn`, `tool_use`, `max_tokens`, `refusal`, `error`. |
| `output_digest` | string | yes | `sha256:<hex>` of the canonical serialized response. |
| `text` | string | no | Assistant text content when representable within the frame limit; larger content is carried by digest only and flagged. |
| `truncated` | boolean | yes | True when `text` was omitted or shortened to satisfy framing rule 3. |
| `provider_latency_ms` | integer | yes | Adapter-observed provider latency, `>= 0`; feeds the latency split in FR-BUD-006. |

#### tool_call

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `call_id` | string | yes | Unique within the run, 1–128 chars. |
| `request_id` | string | no | The `model_request` that proposed the call, when the agent exposes that linkage. |
| `turn` | integer | yes | Same semantics as `model_request.turn`. |
| `tool` | string | yes | Must name a tool declared in the handshake catalog. An undeclared name is a conformance defect: the frame is kept, the run is flagged, and catalog-dependent metrics for the run are reported as degraded. |
| `arguments` | object | yes | Canonical JSON arguments; subject to the frame size limit, with `truncated` semantics as in `model_response`. |
| `truncated` | boolean | yes | As above. |

#### tool_result

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `call_id` | string | yes | Must match an open `tool_call`; exactly one result per call before the terminal frame. |
| `status` | string | yes | One of `ok`, `error`, `denied`, `timeout`. |
| `output` | string | no | Bounded textual result; larger output is stored by the adapter into the workspace or dropped, and represented here by digest. |
| `output_digest` | string | yes | `sha256:<hex>` of the full result bytes. |
| `truncated` | boolean | yes | As in `model_response`. |
| `duration_ms` | integer | yes | Tool execution time observed by the adapter, `>= 0`. |

#### text_output

User-visible assistant text that is not tied to a single model response
frame (streamed summaries, final messages).

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `turn` | integer | yes | As above. |
| `text` | string | yes | 1 byte minimum, frame limit maximum. |
| `final` | boolean | yes | True for the message the agent presents as its final answer; at most one frame per run may set it. |

#### usage

One frame per `request_id`, after its `model_response` (ADR-0009,
FR-ADAPT-008).

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `request_id` | string | yes | Must match a responded `model_request`; at most one `usage` frame per request. |
| `input_tokens` | integer | yes | `>= 0`. |
| `output_tokens` | integer | yes | `>= 0`. |
| `total_tokens` | integer | yes | Must equal `input_tokens + output_tokens`. |
| `cost_usd` | number | no | Provider-reported dollar cost when available; `>= 0`, at most 6 decimal places. |
| `source` | string | yes | One of `provider`, `estimated`, `synthetic`. Budget gates accept `provider` (after reconciliation) and `synthetic` (zero cost); `estimated` usage never satisfies a dollar budget and is labeled in reports. |

The harness independently derives an estimate from its pricing catalog and
reconciles per request and per run; a discrepancy beyond 1% of tokens or
$0.01 marks the run `usage_unreconciled`, which fails cost budgets closed
(ADR-0009, FR-BUD-003).

#### run_completed

Terminal success frame. Required before exit code 0.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `turns` | integer | yes | Total agent turns, `>= 1`. |
| `totals` | object | yes | Fields below. |
| `totals.input_tokens` | integer | yes | Must equal the sum over all `usage` frames; zero when `reports_usage` is false. |
| `totals.output_tokens` | integer | yes | Same summation rule. |
| `totals.cost_usd` | number | no | Must equal the sum of per-request `cost_usd` values when any were reported. |

`run_completed` asserts only that the agent finished its attempt. Task
pass/fail is decided by Assay's assertions, never by the adapter.

#### run_failed

Terminal failure frame. The adapter must exit nonzero after emitting it.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `category` | string | yes | One of `agent_error`, `provider_error`, `cancelled`, `internal`. The harness maps these into its error taxonomy: `provider_error` refines into provider categories where evidence allows; `internal` becomes `adapter_protocol_error`. |
| `message` | string | yes | 1–4,096 bytes, redaction-safe by construction on the adapter side and re-redacted by the harness. |
| `retryable` | boolean | yes | Adapter's judgment; the harness's retry policy remains authoritative. |

#### log

Diagnostic frame; never affects scoring.

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `level` | string | yes | One of `debug`, `info`, `warn`, `error`. |
| `message` | string | yes | 1–4,096 bytes. |

### 2.8 Ordering and termination semantics

Ordering rules, checked by the harness on every run:

1. `handshake` is frame 1; `session_started` is frame 2.
2. `model_response` follows its `model_request`; exactly one per request.
3. `usage` follows the `model_response` for its `request_id`.
4. `tool_result` follows its `tool_call`; every `tool_call` has exactly one
   `tool_result` before the terminal frame.
5. `turn` values never decrease.
6. Exactly one terminal frame (`run_completed` or `run_failed`) is emitted,
   and it is the last frame. Any frame after it is a protocol error,
   counted, and the run is marked `adapter_protocol_error`.
7. `seq` is contiguous from 1 (framing rule 4).

Exit semantics:

| Adapter exit | Required stream state | Harness classification |
| --- | --- | --- |
| 0 | `run_completed` was the last frame | Run collected; proceed to assertions. |
| 0 | No terminal frame, or `run_failed` last | `adapter_protocol_error`; run is infrastructure error, task outcome `error` (FR-RUN-003). |
| 1 | `run_failed` was the last frame | Failure classified from `run_failed.category`. |
| 2 | Emitted before `session_started` | Invalid run spec; `adapter_protocol_error` attributed to the harness/adapter boundary, never to the task. |
| any other, or signal death | any | Crash. Partial trajectory persists with an explicit truncation marker (FR-TRAJ-009); classification per the crash-classification conformance group. |

Timeouts and cancellation: the harness enforces its own monotonic wall-clock
timer regardless of `timeout_ms`. On timeout or user cancellation it sends
SIGTERM, waits a 10,000 ms grace period, then sends SIGKILL to the process
group. An adapter with `supports_cancellation: true` must exit within the
grace period, may emit `run_failed` with `category: "cancelled"` first, and
must terminate its children. The run's terminal state is `timed_out` or
`cancelled` respectively; the partial trajectory is retained with a
truncation marker.

### 2.9 Version negotiation

Per FR-ADAPT-010:

1. The harness advertises its contract in the environment
   (`ASSAY_ADAPTER_CONTRACT`) and the run spec (`contract_version`,
   `contract_minor`).
2. The adapter declares its contract in the handshake.
3. Majors must match exactly. A handshake with any major other than `1` fails
   the run immediately with the stable error
   `adapter_protocol_error: unsupported adapter contract major`, before any
   further frame is read. The same stable error text is used in reports and
   exit diagnostics so scripts can match it.
4. Minors are forward-tolerant in one direction: an adapter at a lower or
   equal minor is fully supported; an adapter at a higher minor may emit
   frame types or fields the harness does not know, which the harness
   ignores-with-count per framing rule 5. Required semantics never change
   within a major.
5. The contract document (this file) is versioned with the contract. Any
   change that would break a conforming `assay-adapter/1` adapter requires
   `assay-adapter/2` (NFR-MAINT-003).

## 3. Conformance tiers

Assay assigns each adapter one of three tiers. The tier is computed by the
conformance suite (section 4) and recorded with the adapter identity in every
run record (FR-RUN-007) and every report row. An optional qualifier such as
`pinned-preview` (section 5) annotates the tier without changing its
measurement semantics.

| Tier | Requires | Unlocks |
| --- | --- | --- |
| `full` | Conforming handshake and event stream, tool catalog with semantic classes, one reconciled `usage` frame per model request | Every assertion layer, every trajectory metric, every budget type, full statistical comparison. |
| `trajectory` | Conforming handshake and event stream; usage absent, incomplete, or unreconcilable | Everything in `full` except token and dollar accounting. |
| `black-box` | A registered executable with no event stream | Final-state evaluation only. |

### 3.1 `full`

Can measure: pass rates over the deterministic, checker, and judge assertion
layers; all FR-TRAJ-003 trajectory metrics (tool-selection correctness,
ordering sanity, redundant-call count, read-before-write discipline,
error-recovery versus loop, turns-to-completion, cost-per-turn); token,
dollar, wall-clock, and tool-call-count budgets; every statistical
comparison, including cost deltas.

Cannot measure: anything the sandbox cannot see — provider-side state,
network activity the adapter does not surface, agent-internal reasoning not
reflected in events.

Report labeling: rows carry `tier: full`. No columns are suppressed. If a
specific run within a full-tier adapter's results was `usage_unreconciled`,
that run's cost cells show `unreconciled` and any dollar budget over it fails
closed (FR-BUD-003); the tier itself is unaffected.

### 3.2 `trajectory`

Can measure: everything in `full` except cost: all assertion layers, all
trajectory metrics, wall-clock budgets (harness-timed) and tool-call-count
budgets (counted from `tool_call` frames).

Cannot measure: token budgets, dollar budgets, cost-per-turn, or any cost
delta. Declaring a token or dollar budget on a suite run at this tier is a
configuration error rejected by `assay validate`, not a silently skipped
check.

Report labeling: rows carry `tier: trajectory`. Cost columns render the
literal string `unavailable (trajectory tier)`. Comparison reports that mix
tiers state, above the delta table: `Cost comparison unavailable: candidate
adapter conformance tier is trajectory.`

### 3.3 `black-box`

Assay observes only: the workspace before the run (fixture snapshot), the
workspace after the run (content-addressed snapshot, FR-SAND-008), the
process exit status, and bounded stderr. No handshake is awaited and stdout
is captured as an opaque bounded diagnostic, not parsed as frames
(FR-ADAPT-007).

Can measure: final-state deterministic assertions (`exit_code`,
`file_exists`, `file_contains`, `file_absent`, `json_schema`,
`diff_matches`, `tests_pass`, `command_output`), checker assertions over the
workspace snapshot, pass rates and their statistical comparison, and
wall-clock budgets.

Cannot measure: any trajectory metric, any tool-call-count budget, any token
or dollar budget, any turn-level diff in the viewer, or any judge assertion
whose rubric requires trajectory input. Suites declaring any of those against
a black-box adapter are rejected by `assay validate` with a stable error
naming the tier limit.

Report labeling: rows carry `tier: black-box`. Trajectory-metric and cost
columns render `unavailable (black-box tier)`, and every report containing
black-box rows includes the fixed sentence: `Black-box runs are scored on
final workspace state and exit status only; no claim is made about how the
agent produced them.`

## 4. The conformance suite

`packages/adapter-core` ships the conformance suite (FR-ADAPT-002). It runs
an adapter against scripted run specs and adversarial harness behavior,
produces a signed-content conformance record (adapter id, version, contract
minor, tier, defect list, suite version), and is a prerequisite for an
adapter to be referenced by a suite at `full` or `trajectory` tier. The suite
itself is deterministic and free: it needs no provider, no credentials, and
no network (NFR-DET-001, NFR-COST-001).

Each test group below lists its first failing condition — the cheapest
observable symptom that the group would catch — and the assertion that must
pass for the group to pass.

### 4.1 Handshake validity

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| First-frame discipline | Any frame precedes `handshake` | Frame 1 is a schema-valid `handshake`; frame 2 is `session_started`. |
| Deadline | No handshake within 10,000 ms | Handshake arrives inside the deadline on a cold spawn. |
| Identity completeness | Missing adapter, agent, or capability field | Every required handshake field validates against the section 2.6 schema. |
| Catalog coherence | Duplicate tool name or unknown semantic class | Tool names unique; every `semantic_class` is `read`, `write`, or `execute`. |
| Capability honesty | A declared flag is disproved by any later group | No conformance defect contradicts a declared capability flag. |

### 4.2 Frame schema fuzzing

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| Field fuzz | Adapter emits a frame that fails its field schema under seeded input mutation of the run spec | Ten thousand seeded mutated run specs produce only schema-valid frames or a clean exit-2 spec rejection. |
| Size discipline | Any frame exceeds 1 MiB | Oversized payloads are truncated with `truncated: true` and digests intact, never emitted oversized. |
| Encoding | Invalid UTF-8 or embedded raw newline inside a frame | All frames decode as UTF-8 and contain no unescaped LF. |
| Sequence integrity | `seq` gap, repeat, or restart | `seq` is contiguous from 1 across every scripted scenario. |

### 4.3 Ordering rules

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| Request/response pairing | `model_response` or `usage` without a matching open request | Every response and usage frame matches rule 2–3 of section 2.8. |
| Call/result pairing | A `tool_call` left open at the terminal frame | Every call has exactly one result before termination. |
| Turn monotonicity | A `turn` value decreases | Turn values are non-decreasing in every scenario. |
| Terminal uniqueness | Zero or two terminal frames, or frames after the terminal | Exactly one terminal frame, emitted last. |

### 4.4 Usage arithmetic consistency

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| Per-frame arithmetic | `total_tokens != input_tokens + output_tokens` | Every usage frame satisfies the sum rule with non-negative integers. |
| Run totals | `run_completed.totals` differs from the frame sums | Totals equal the exact sums of per-request usage. |
| Source labeling | Synthetic runs report a non-`synthetic` source or nonzero cost | Synthetic scenarios report `source: "synthetic"` and zero cost (ADR-0009). |
| Reconciliation input | Usage omitted for some requests while `reports_usage` is true | Usage coverage is total, or the flag is false and the tier ceiling drops to `trajectory`. |

### 4.5 Cancellation behavior

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| Grace-period exit | Process alive 10,000 ms after SIGTERM | Adapter and its whole process group exit within the grace period. |
| Terminal honesty | Frames continue after a `cancelled` `run_failed` | The cancellation terminal frame, when emitted, is last. |
| Child cleanup | An orphaned child survives adapter exit | No process from the adapter's group survives in the sandbox. |
| Mid-stream cut | Cancellation during a tool call corrupts framing | The stream up to termination remains schema-valid and parseable. |

### 4.6 Crash classification

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| Abrupt exit | Harness misclassifies a scripted crash as task failure | A mid-run nonzero exit without a terminal frame classifies as infrastructure error with outcome `error` (FR-RUN-003). |
| Signal death | SIGKILL death loses the partial trajectory | The partial trajectory persists with a truncation marker (FR-TRAJ-009). |
| Exit-0 lie | Exit 0 without `run_completed` is accepted | The harness records `adapter_protocol_error` and refuses to score the run as collected. |
| Stderr flood | Unbounded stderr stalls or bloats the harness | Capture stops at 256 KiB with a recorded dropped-byte count. |

An adapter passes at `full` when groups 4.1–4.6 pass with usage coverage; at
`trajectory` when 4.1–4.3, 4.5, and 4.6 pass and only usage-dependent checks
fail or are out of scope. Black-box registrations skip the suite and receive
the black-box record directly, since the tier claims nothing the suite would
test.

## 5. The Robin reference adapter

`packages/adapter-robin` is the reference adapter for a real subject
(FR-ADAPT-004). Robin is a local-first, provider-flexible coding agent for
the terminal; its repository ships a deterministic, credential-free
**synthetic model provider** and a headless surface. The adapter wraps a
pinned Robin build as a subprocess:

```text
node <pinned-robin>/apps/cli/dist/bin.js --print \
  --output-format stream-json "<prompt>"
```

against that synthetic provider. Nothing from Robin is linked in-process, and
none of Robin's internal packages are imported (ADR-0005).

### 5.1 Pinned-preview tier

Robin's own compatibility plan is explicit that its automation contract —
headless flags, stream-JSON schemas, and permission behavior — stabilizes at
Robin's R7 gate. Today those surfaces are preview: Robin's machine formats
declare `stability: "experimental"`, and the current preview spelling
`--output-format stream-json` differs from Robin's documented target spelling
`--output stream-json`. The adapter therefore:

1. pins the exact Robin commit and flag spellings it was tested against and
   records them in its handshake `agent.version`;
2. carries the tier qualifier `pinned-preview` on its conformance record and
   in every report row containing its runs;
3. has a standing re-verification obligation: when Robin's R7 gate freezes
   the automation contract, the adapter must re-run the full conformance
   suite against the frozen surface, update its pins, and drop the qualifier
   only after passing. Until then, an unpinned Robin build is not a supported
   subject — running one is an unsupported experiment, reported as such.

### 5.2 Event mapping

The mapping below targets the Robin event vocabulary pinned at the tested
commit. Robin's current preview loop is text-only over the synthetic
provider; rows marked `specified` map Robin's planned tool-loop events and
are validated when the pinned Robin build first emits them, before any run
relying on them is scored.

| Robin stream-JSON observation | `assay-adapter/1` frame | Status at pin |
| --- | --- | --- |
| Stream/turn opening record | `session_started` | validated |
| Provider request boundary for a turn | `model_request` | validated |
| Sealed assistant content (coalesced text deltas) | `model_response`, then `text_output` (`final` on the terminal turn message) | validated |
| Normalized tool proposal (`ProviderToolCallCompleted` / `ToolRequestNormalized` lineage) | `tool_call` | specified |
| Settled tool execution record | `tool_result` | specified |
| Usage/status record for the request | `usage` with `source: "synthetic"`, zero cost | validated |
| Terminal turn event, completed | `run_completed` | validated |
| Terminal turn event, failed or cancelled | `run_failed` (`agent_error` or `cancelled`) | validated |
| Bounded diagnostic record | `log` | validated |
| Unknown or malformed Robin frame | dropped, counted, bounded capture; never forwarded | validated |

Robin permission records and interaction phases are transient display facts
in Robin's own model; the adapter never converts them into scoring-relevant
frames.

### 5.3 What the synthetic provider gives Assay

Robin's synthetic provider is deterministic and needs no credential, no
network, and no money. Wrapped by this adapter, it gives Assay a real
external agent whose runs are reproducible byte-for-byte and cost $0 — an
end-to-end integration proof that a subject outside Assay's repository can be
spawned, streamed, scored, and compared (NFR-DET-005).

The evidence rule is fixed: **Assay's own gate evidence rests on the in-repo
simulated adapter; Robin-synthetic e2e runs are integration evidence layered
on top.** The simulated adapter proves harness logic with zero external
dependencies; the Robin adapter proves the adapter boundary against a real
subject. Neither substitutes for the other, and no paid live provider is ever
used to prove logic a synthetic subject can prove.

## 6. The simulated adapter

`packages/adapter-simulated` ships in-repo (FR-ADAPT-003). It is a scripted
agent: a conforming `assay-adapter/1` process that replays a scenario file
deterministically, with no model, no network, and no cost. It exists so that
every runner, capture, metric, budget, and statistics behavior has a
reproducible subject in required CI (NFR-DET-001, NFR-DET-004).

### 6.1 Scenario file sketch

Scenarios are YAML files in `fixtures/trajectories/`, validated by a
published JSON Schema before use. Sketch (normative schema lands with R1):

```yaml
scenario_version: "1.0"
id: tool-loop-redundant-read
description: >
  Completes the task but reads the same file three times, exercising the
  redundant-call metric.
handshake:
  agent: { id: simulated, version: "1.0.0" }
  model: { provider: synthetic, model_id: sim-1 }
  tools:
    - { name: read_file, semantic_class: read }
    - { name: write_file, semantic_class: write }
    - { name: run_tests, semantic_class: execute }
  capabilities:
    emits_tool_events: true
    reports_usage: true
    reports_cost: false
    supports_cancellation: true
    deterministic: true
steps:
  - emit: model_request
    with: { turn: 1 }
  - emit: model_response
    with: { stop_reason: tool_use }
  - emit: tool_call
    with: { tool: read_file, arguments: { path: src/app.ts } }
  - repeat: 2
    of:
      - emit: tool_call
        with: { tool: read_file, arguments: { path: src/app.ts } }
      - emit: tool_result
        with: { status: ok }
  - emit: usage
    with: { input_tokens: 120, output_tokens: 40 }
  - misbehave: none
  - emit: run_completed
```

The `misbehave` directive is the negative-testing hook. Its values select
scripted contract violations: `oversized_frame`, `malformed_json`,
`sequence_gap`, `post_terminal_frame`, `missing_tool_result`,
`usage_arithmetic_error`, `exit_zero_without_terminal`, `crash_at_step`,
`hang_until_timeout`, `ignore_sigterm`. Scenarios with a violation are used
to prove the harness's handling; scenarios without one are golden subjects.

### 6.2 Covered behaviors

The shipped scenario set covers, deterministically:

- plain text answers (single-turn and multi-turn);
- tool-call/result cycles across all three semantic classes, including
  read-before-write ordering both honored and violated;
- redundant identical calls versus principled retry-after-new-information,
  the FR-TRAJ-006 distinction;
- error results followed by recovery, and error results followed by loops;
- usage patterns: complete, absent, partially absent, and arithmetically
  inconsistent;
- malformed, oversized, unknown-type, and post-terminal frames;
- crashes, hangs, cancellation compliance, and cancellation defiance;
- budget-relevant shapes: long runs, many-call runs, and token-heavy usage
  that trip declared thresholds on purpose.

## 7. Writing a new adapter

### 7.1 Checklist

1. Confirm the agent can run headlessly inside an OCI container with no
   network by default; if it cannot observe its own events, target the
   black-box tier and stop after step 3.
2. Decide the honest capability flags. Do not declare `reports_usage` unless
   the agent surfaces provider-reported usage per request; declare estimates
   as `source: "estimated"` and accept that they never satisfy dollar
   budgets.
3. Pin the agent version exactly (commit, tag, or digest) and emit it in the
   handshake. A moving target cannot hold a conformance record.
4. Map the agent's native event stream onto the ten frame types, buffering
   deltas into sealed frames; never invent events the agent did not exhibit.
5. Declare the tool catalog with conservative semantic classes; when unsure,
   declare `execute`.
6. Implement termination: emit exactly one terminal frame, exit 0 only after
   `run_completed`, handle SIGTERM within the grace period, kill children.
7. Redact defensively on your side even though the harness redacts at
   capture; a secret that never enters a frame cannot need redaction.
8. Run the conformance suite locally until groups 4.1–4.6 pass; commit the
   conformance record next to the adapter.
9. Add at least one deterministic end-to-end fixture so the adapter's
   mapping is covered in CI without the real agent's paid dependencies.

### 7.2 Minimal skeleton

```ts
import { createInterface } from "node:readline";
import { stdin, stdout, exit } from "node:process";

type Frame = Record<string, unknown> & { type: string };

let seq = 0;
const emit = (frame: Omit<Frame, "seq" | "ts">): void => {
  seq += 1;
  const line = JSON.stringify({
    ...frame,
    seq,
    ts: new Date().toISOString(),
  });
  if (Buffer.byteLength(line, "utf8") >= 1_048_576) {
    throw new Error("frame exceeds assay-adapter/1 limit");
  }
  stdout.write(`${line}\n`);
};

const readRunSpec = async (): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const main = async (): Promise<void> => {
  const spec = await readRunSpec();
  if (spec["contract_version"] !== "assay-adapter/1") exit(2);

  emit({
    type: "handshake",
    contract_version: "assay-adapter/1",
    contract_minor: 0,
    adapter: { id: "my-agent", version: "0.1.0" },
    agent: { id: "my-agent-cli", version: "pinned-commit-sha" },
    model: { provider: "synthetic", model_id: "example" },
    tools: [{ name: "read_file", semantic_class: "read" }],
    capabilities: {
      emits_tool_events: true,
      reports_usage: false,
      reports_cost: false,
      supports_cancellation: true,
      deterministic: false,
    },
  });
  emit({
    type: "session_started",
    session_id: String(spec["run_id"]),
    task_id: String(spec["task_id"]),
    attempt: Number(spec["attempt"]),
    seed_honored: false,
  });

  // Drive the real agent here, translating its events into frames.

  emit({
    type: "run_completed",
    turns: 1,
    totals: { input_tokens: 0, output_tokens: 0 },
  });
  exit(0);
};

process.on("SIGTERM", () => {
  emit({
    type: "run_failed",
    category: "cancelled",
    message: "cancelled by harness",
    retryable: false,
  });
  exit(1);
});

void main();
```

The skeleton omits the agent-driving core on purpose: that part is
adapter-specific, and everything around it is the contract.

## 8. Explicit deferrals and requirements traced

### 8.1 Deferrals

The following are deferred, recorded in OPEN_QUESTIONS.md with fail-closed
defaults and reopen triggers; none may be used as completion evidence:

- **MCP-based adapters** — driving a subject through a Model Context Protocol
  session instead of a subprocess. Fail-closed default: not a supported
  adapter transport; such agents run black-box or not at all. Reopen trigger:
  a concrete subject that cannot be wrapped as a subprocess.
- **Hosted-API agent subjects** — agents that run on a vendor's servers and
  expose only an HTTP API. Fail-closed default: unsupported; the sandbox and
  isolation claims of ADR-0004 do not extend to remote execution. Reopen
  trigger: a design that states honestly which sandbox and privacy claims are
  lost.
- **Multi-agent subjects** — evaluating a coordinator plus workers as one
  subject with per-agent attribution. Fail-closed default: the ensemble is
  one subject; all frames attribute to it; no per-worker metric is claimed.
  Reopen trigger: demand for per-worker trajectory attribution backed by a
  concrete event model.

### 8.2 Requirements traced

| Requirement | Where satisfied in this document |
| --- | --- |
| FR-ADAPT-001 | Sections 2.1–2.9: handshake, events, termination under the versioned `assay-adapter/1` contract. |
| FR-ADAPT-002 | Section 4: conformance suite and tier assignment; section 3 tier semantics. |
| FR-ADAPT-003 | Section 6: in-repo simulated adapter and covered behaviors. |
| FR-ADAPT-004 | Section 5: Robin reference adapter over `robin --print` stream-JSON. |
| FR-ADAPT-005 | Sections 2.2 (stderr bounds) and 2.4 (malformed-frame handling). |
| FR-ADAPT-006 | Section 2.6 tool catalog schema; section 3.1 metric dependence. |
| FR-ADAPT-007 | Section 3.3: black-box tier and its stated report limits. |
| FR-ADAPT-008 | Sections 2.6 (model identity) and 2.7 (`usage` frame per request). |
| FR-ADAPT-009 | Section 2.1: adapter runs inside the sandbox under task policy. |
| FR-ADAPT-010 | Section 2.9: version negotiation and the stable unknown-major error. |

Every measurement claim in this document is `planned` until the owning gate's
evidence exists; the tier system exists precisely so that no adapter — and no
version of Assay — ever claims a measurement its evidence does not support.
