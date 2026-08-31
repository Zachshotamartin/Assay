# Assay Agent Compatibility and Adapter Conformance

Document status: normative for adapter conformance details. The R1 simulated
adapter contract has branch-local implementation and local evidence but is not
accepted; Robin and later conformance behavior remain planned. Where this
document conflicts with an accepted ADR, PRODUCT_REQUIREMENTS.md,
METHODOLOGY.md, BUILD_PLAN.md, ARCHITECTURE.md, or TASK_FORMAT.md, those
documents control, in that order.

Last revised: 2026-08-30.

> Assay is under implementation. Gates R0 and R1 have code and local evidence
> on gate branches, but neither is accepted: R0 is blocked by unavailable
> private-repository branch protection and review controls on the current GitHub
> plan, and R1 depends on accepted R0. No product gate is accepted.

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
4. An agent whose adapter cannot emit rich trajectory events can still be
   evaluated in the black-box tier: its adapter emits only the required
   handshake, session, and terminal lifecycle while Assay observes the
   sandbox workspace and exit status and reports the measurement limits.
5. No adapter can widen its claims by configuration. Declaring a capability
   flag the conformance suite disproves demotes the adapter, and the demotion
   is recorded in every report that includes its runs.

"Any agent" therefore means: any agent behind an adapter with a recorded
conformance result, at the tier that result assigns. It never means that
pointing Assay at an unknown executable produces trajectory metrics, cost
accounting, or statistical comparisons of them. That restriction is the
compatibility claim, not a caveat to it.

## 2. The assay-adapter/1 contract

This section publishes the pre-release major-1 contract frozen by R1.06.
ADR-0014 resolves the former planning conflict: ARCHITECTURE.md section 6,
subject to higher-precedence Product and Build Plan rules, controls this wire
format. The superseded draft used contract_version, agent, tools, and a
run-spec-first lifecycle; those names and behaviors are not aliases and are
rejected by the current schemas.

The machine-readable schemas are:

- packages/adapter-core/schemas/handshake.v1.schema.json
- packages/adapter-core/schemas/run-spec.v1.schema.json
- packages/adapter-core/schemas/adapter-event.v1.schema.json

The accept/reject corpus beside packages/adapter-core/src/frames/codec.test.ts
is executable publication evidence for every frame variant.

### 2.1 Subprocess and transport lifecycle

One adapter process serves one task-run attempt. The adapter command is an
argv array from configuration; the harness appends exactly
--assay-adapter. Prompts, task data, paths, seeds, and credentials never
appear in argv.

The harness constructs, rather than inherits, the adapter environment. It
contains only sandbox PATH, HOME, and TMPDIR; LANG=C.UTF-8 and
LC_ALL=C.UTF-8; ASSAY_ADAPTER_CONTRACT=assay-adapter/1; task-declared
variables; and credentials the task explicitly declares and resolves at
spawn. The redacted constructed environment is recorded. The adapter starts
in the sandbox workspace root.

The lifecycle is ordered:

1. The harness spawns the adapter and starts the 10,000 ms handshake timer.
2. The adapter emits the handshake as stdout frame 1. Nothing may precede it.
3. After validating that frame, the harness writes exactly one LF-terminated
   run_spec JSON object to stdin. Stdin remains open in major 1.
4. The adapter emits event frames on stdout and diagnostics on stderr.
5. A terminal event is followed by exit code 0 within 5,000 ms.
6. Timeout, cancellation, or a hard protocol budget sends SIGTERM, waits
   5,000 ms, then sends SIGKILL if the process remains alive.

Cancellation is signal-based in major 1. Stdout is reserved for protocol
frames. Stderr is diagnostic only and never influences scoring; the harness
retains a bounded 256 KiB head-and-tail ring, records dropped-byte count, and
redacts before persistence.

### 2.2 JSONL framing and bounds

Every adapter-to-harness frame is one UTF-8 JSON object terminated by LF.
CR, BOM, blank lines, invalid UTF-8, and an EOF partial line are malformed.
A frame is at most 1,048,576 bytes including LF. A task run is at most 50,000
frames or 268,435,456 stdout bytes, whichever arrives first.

Every adapter frame carries a positive integer seq. The handshake is seq 1;
each later frame increments by exactly one. Event frames after the handshake
also carry ts, an RFC 3339 UTC timestamp with exactly millisecond precision.
Sequence, not timestamp, is ordering authority. The handshake intentionally
has no ts field.

A payload string over 262,144 bytes must be truncated by the adapter and
identified on that frame with truncated: true plus original_sha256. This
metadata applies to model-response text, tool-result output, text output,
terminal summary/message, and log message. Identity, pairing, catalog, and
model strings cannot be safely shortened and are rejected at the same byte
bound. The harness applies the payload bound defensively, computes the hash,
and records its action in the redaction manifest.

### 2.3 Handshake

The first frame has this exact shape:

~~~json
{"type":"handshake","seq":1,"contract":"assay-adapter/1","adapter":{"id":"adapter-simulated","version":"1.0.0"},"tier":"full","model":{"provider":"synthetic","model":"scripted-v1","family":"synthetic"},"tool_catalog":[{"name":"read_file","semantic_class":"read"},{"name":"write_file","semantic_class":"write"},{"name":"run_command","semantic_class":"execute"}],"capabilities":{"usage_reporting":true,"cost_reporting":false,"streaming_text":true}}
~~~

| Field | Rule |
| --- | --- |
| type | Exactly handshake. |
| seq | Exactly 1. |
| contract | Pattern assay-adapter/<major>; only major 1 is accepted. |
| adapter.id | Pattern [a-z0-9-]{1,64}. |
| adapter.version | SemVer. |
| tier | full, trajectory, or black_box. |
| model | provider, model, and family strings; required and non-null for full/trajectory, nullable for black_box. |
| tool_catalog | Required for full/trajectory; names are unique and semantic_class is read, write, or execute. |
| capabilities | The boolean keys usage_reporting, cost_reporting, and streaming_text; unknown keys are rejected. |

A tool_call may name an uncataloged tool. The frame remains valid, while
catalog-dependent metrics treat its semantic class as unknown.

### 2.4 Run specification

After a valid handshake the harness writes one line and keeps stdin open:

~~~json
{"type":"run_spec","contract":"assay-adapter/1","task_id":"fix-null-deref","task_run_id":"018f0f5e-7b3c-7def-8abc-0123456789ab","prompt":"Fix the null dereference.","workspace_path":"/workspace","seed":"5f2a9c01d4e8b7a3","env":{"TASK_DECLARED_VAR":"value"},"limits":{"wall_clock_ms":600000},"budgets_advisory":{"total_tokens":200000,"tool_calls":100,"usd_micros":500000}}
~~~

All top-level fields shown are required and unknown fields are rejected.
task_id and task_run_id use the shared branded identifier contracts. seed is
a string. env values are strings. limits.wall_clock_ms is a positive integer.
The three budgets_advisory fields are optional non-negative integers and are
informational; enforcement remains harness-side.

### 2.5 Event frames

All events add seq and ts to the fields below. Objects are strict: unknown
fields and unknown types are rejected in the current v1 schema.

| Type | Required payload |
| --- | --- |
| session_started | session_id string. Exactly once, immediately after the handshake. |
| model_request | request_id string unique in the run; turn non-negative and monotonically nondecreasing; model with provider/model/family; message_count non-negative integer; input_summary_sha256 as 64 lowercase hex characters. |
| model_response | request_id matching an open request; status ok, provider_error, or timeout; stop_reason required for ok and one of end_turn, tool_use, max_tokens, refusal, other; latency_ms non-negative integer; optional text string or null. |
| tool_call | call_id unique in the run; request_id; tool string; complete args object. |
| tool_result | call_id matching an open call; status ok, error, or timeout; result string; duration_ms non-negative integer. |
| usage | request_id; prompt_tokens, completion_tokens, and total_tokens non-negative integers; optional cost_usd_micros non-negative integer; source provider or synthetic. total_tokens must equal the other two token counts. Synthetic usage has zero cost. |
| text_output | text string. |
| run_completed | summary string. |
| run_failed | category agent_gave_up, agent_crashed, provider_error, or internal; message string. |
| log | level debug, info, warn, or error; message string. |

Every model_response and usage relates to an open model_request, and each kind
appears at most once per request. Every tool_result closes an open tool_call.
Unmatched or duplicate identifiers are malformed. Any request or call left
open at termination makes the trajectory incomplete. Exactly one terminal
frame is required and it must be last.

Both run_completed and run_failed are evidence, not task verdicts. Either is
followed by exit code 0. Exit 0 without a terminal, any nonzero exit, a signal
death, or stdout EOF mid-frame is adapter_protocol_error and preserves an
explicitly truncated partial trajectory.

### 2.6 Malformed-frame policy

Oversize, invalid UTF-8, non-object JSON, schema failure, sequence failure,
and cross-frame failure are malformed. For each malformed line the harness:

1. retains at most 4 KiB through fail-closed redaction, never raw fallback;
2. marks the trajectory incomplete; and
3. continues collecting unless the handshake was malformed, a hard stream
   budget was exceeded, or the malformed count exceeds 10.

The eleventh malformed frame terminates the adapter with
adapter_protocol_error. A redaction failure persists no raw bytes and fails
as redaction_failed. All validated frames also pass redaction before
retention.

### 2.7 Version negotiation

The handshake contract field carries the major. assay-adapter/1 is the only
currently published and accepted contract. A syntactically valid unknown
major is rejected before event processing with adapter_nonconformant.
Malformed current-v1 frames use adapter_protocol_error.

The current v1 schemas reject unknown event types and unknown fields.
Additive future-minor behavior is available only after the harness explicitly
publishes, negotiates, and understands that schema. After R1 publication, an
incompatible change requires assay-adapter/2 and a new ADR.

## 3. Conformance tiers

The adapter claims a tier in its handshake; the conformance suite may
downgrade but never upgrade it.

| Tier | Requirements proven | Measurements unlocked |
| --- | --- | --- |
| full | Handshake, all ten event types, pairing, usage for every request, catalog completeness, and termination semantics. | Trajectory metrics and assertions, reconciled token/dollar budgets, final-state assertions, diffs, and judge inputs. |
| trajectory | Full stream behavior without usage/cost fidelity. | Trajectory and final-state measurements; token and dollar budgets are unavailable and rejected at validation. |
| black_box | Handshake, session_started, one terminal frame, and clean exit. | Final-state assertions only. |

Black-box adapters still speak the major-1 framing lifecycle. Their model may
be null and their tool catalog may be empty. Reports state:
Black-box runs are scored on final workspace state and exit status only; no
claim is made about how the agent produced them. They do not unlock
trajectory, tool-count, token, cost, or trajectory-dependent judge claims.

A pinned-preview qualifier may annotate a tier without replacing it.

## 4. Conformance suite

packages/adapter-core owns the deterministic, credential-free, no-network
conformance suite. Its record names adapter id/version, negotiated contract,
effective tier, defects, and suite version.

### 4.1 Required groups

| Group | Required evidence |
| --- | --- |
| Handshake | First-frame discipline, 10-second deadline, exact identity/tier/model/catalog/capabilities schema, unique tool names, and unknown-major rejection as adapter_nonconformant. |
| Framing | Fatal UTF-8 validation, LF-only lines, 1 MiB frame bound, 50,000-frame and 256 MiB stream budgets, contiguous sequence, strict current-v1 types and fields. |
| Ordering | session_started immediately after handshake; request/response/usage and call/result matching; nondecreasing 0-based turns; exactly one final terminal. |
| Usage | Non-negative integer arithmetic, source labeling, synthetic zero cost, and complete coverage for full tier. |
| Termination | Both terminal types followed by exit 0 within 5 seconds; missing terminal, nonzero exit, post-terminal output, hangs, and crashes classified without a harness crash. |
| Bounds and privacy | At most ten malformed frames continue; the eleventh terminates; diagnostics are 4 KiB bounded; stderr is a 256 KiB head-and-tail capture; all persistence is fail-closed redacted. |
| Signals | Timeout/cancel sends SIGTERM, then SIGKILL after 5 seconds; partial trajectory has a truncation marker and no orphaned process remains. |

Full tier requires every group and usage coverage. Trajectory permits only
usage/cost-fidelity defects. Black-box proves its smaller handshake/session/
terminal contract and receives only final-state capabilities.

## 5. Robin reference adapter

packages/adapter-robin wraps a pinned Robin build as a subprocess and never
imports Robin packages (ADR-0005). The current preview invocation is pinned
to the exact tested commit and command:

~~~text
robin --print <prompt> --output-format stream-json
~~~

The adapter translates Robin observations into the ten published frame
types, coalescing native deltas into bounded sealed frames. It emits model
identity using provider, model, and family; maps failures into one of the
published run_failed categories; reports synthetic usage with zero micro-USD;
and drops, counts, bounds, and redacts malformed Robin-native records rather
than forwarding them.

Until Robin freezes its automation contract, the adapter carries the
pinned-preview qualifier and re-runs conformance whenever the pin or flag
spelling changes. The Assay repository never modifies the sibling Robin
repository. Required gate evidence rests on adapter-simulated; Robin
synthetic is additional process-boundary evidence and no paid provider is a
required check.

## 6. Simulated adapter

packages/adapter-simulated is the deterministic in-repo subject used by
required CI. It uses no provider, credential, network, or money.

### 6.1 Scenario format

A scenario is strict JSON, never YAML, with numeric scenario_version 1:

~~~json
{
  "scenario_version": 1,
  "steps": [
    {"emit":{"type":"session_started","sessionId":"sim-session"}},
    {"emit":{"type":"text_output","text":"Done."}},
    {"emit":{"type":"run_completed","summary":"Completed scripted run."}}
  ]
}
~~~

An emit object is an exact AdapterEvent payload without seq or ts. The
simulated adapter assigns contiguous sequence values and timestamps from its
injected clock. Directives are sleep_ms, write_file with path and contents,
delete_file with path, and misbehave. File directives are confined to the
run-spec workspace. Identical scenario, seed, and clock inputs produce
byte-identical output.

The package exports `simulatedAdapterCommand()`, whose no-argument form
invokes the shipped `happy-multi-turn` scenario without consulting the
current working directory. Runner composition uses that default; the task
format does not expose a scenario-selection field. Conformance tests may pass
an explicit repository fixture path through the command helper.

Misbehavior scenarios cover malformed JSON, invalid UTF-8, oversized frames,
sequence gaps, frame floods, post-terminal frames, missing tool results,
usage arithmetic errors, exit zero without a terminal, early crashes, hangs,
and SIGTERM defiance. Happy scenarios cover text, multi-turn tool cycles,
tool error and recovery, redundant-call loops, every run_failed category, and
budget-relevant synthetic usage. Synthetic usage always reports source
synthetic and zero cost.

## 7. Writing a new adapter

1. Pin the subject executable version and keep it outside the Assay process.
2. Emit the exact handshake fixture within 10 seconds, then read one run_spec
   line without waiting for stdin EOF.
3. Translate native observations into the ten exact event variants; never
   invent evidence and never put raw child output on protocol stdout.
4. Declare tool semantics conservatively. Uncataloged calls remain valid but
   lose catalog-dependent meaning.
5. Apply the byte/frame/string bounds before emission and keep seq contiguous.
6. Emit exactly one terminal frame, then exit 0 within 5 seconds. Handle
   SIGTERM and terminate children within the 5-second grace.
7. Keep secrets out of argv, logs, frames, traces, configuration, and commits;
   redact defensively even though the harness also redacts at capture.
8. Run all conformance groups and commit the resulting record plus at least
   one deterministic, credential-free fixture.

Use the published JSON schemas and accept fixtures as the implementation
skeleton. Draft field spellings from before ADR-0014 are deliberately not
accepted.

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
| FR-ADAPT-001 | Sections 2.1–2.7: handshake, events, termination under the versioned `assay-adapter/1` contract. |
| FR-ADAPT-002 | Section 4: conformance suite and tier assignment; section 3 tier semantics. |
| FR-ADAPT-003 | Section 6: in-repo simulated adapter and covered behaviors. |
| FR-ADAPT-004 | Section 5: Robin reference adapter over `robin --print` stream-JSON. |
| FR-ADAPT-005 | Sections 2.1–2.2 (stderr/frame bounds) and 2.6 (malformed-frame handling). |
| FR-ADAPT-006 | Section 2.3 tool catalog schema; section 3 tier dependence. |
| FR-ADAPT-007 | Section 3: black-box tier and its stated report limits. |
| FR-ADAPT-008 | Sections 2.3 (model identity) and 2.5 (`usage` frame per request). |
| FR-ADAPT-009 | Section 2.1: adapter runs inside the sandbox under task policy. |
| FR-ADAPT-010 | Section 2.7: version negotiation and the stable unknown-major error. |

Every measurement claim in this document is `planned` until the owning gate's
evidence exists; the tier system exists precisely so that no adapter — and no
version of Assay — ever claims a measurement its evidence does not support.
