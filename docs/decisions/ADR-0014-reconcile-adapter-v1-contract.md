# ADR-0014: Reconcile the Adapter v1 Contract

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-ADAPT-001, FR-ADAPT-005,
  FR-ADAPT-006, FR-ADAPT-008, FR-ADAPT-010, FR-TRAJ-001, FR-TRAJ-005,
  NFR-MAINT-003

## Context

ADR-0005 chose an Assay-owned JSONL subprocess contract and named
AGENT_COMPATIBILITY.md as its schema publication. Before R1 implemented or
published that contract, the planning set acquired two incompatible v1 wire
definitions. AGENT_COMPATIBILITY uses `contract_version`, an `agent` identity,
1-based turns, request and response digests, a run spec written before reading
the handshake, forward-ignored unknown frames, and a nonzero exit after
`run_failed`. Architecture section 6 uses `contract`, a claimed conformance
tier, 0-based turns, a request summary hash and bounded response text, a
handshake before the run spec, strict current-frame rejection, and exit zero
after either terminal frame.

The conflicts also change stable error and supervision behavior. Product
requirements require unknown majors to be `adapter_nonconformant`; the older
compatibility draft says `adapter_protocol_error`. The R1 evidence matrix
requires unknown frame types to be rejected; the older draft ignores them.
The build plan requires a bounded head-and-tail stderr ring, while the older
draft retains only the head. These differences cannot be left to an
implementation choice.

## Decision

The pre-publication `assay-adapter/1` contract is the exact wire contract in
ARCHITECTURE.md section 6, subject to higher-precedence Product and Build Plan
rules. In particular:

- the adapter emits and the harness validates the handshake before the
  harness writes one `run_spec`; stdin remains open for major 1 and
  cancellation is signal-based;
- the handshake uses `contract`, `adapter`, `tier`, `model`, `tool_catalog`,
  and the Architecture capability names; event frames after it use the
  section 6 common envelope and exact snake-case variants;
- the current v1 schema rejects unknown frame types and unknown fields;
  additive future-minor handling requires a published schema the harness
  explicitly negotiates and understands;
- an unknown contract major is `adapter_nonconformant`; malformed current-v1
  frames and ordering defects are `adapter_protocol_error`;
- `run_completed` and `run_failed` are both terminal evidence followed by
  exit code 0; task verdicts remain assertion-owned;
- the Architecture frame, stream, string, malformed-sample, stderr-ring,
  handshake, terminal-exit, and signal-grace bounds are normative; and
- trajectory losslessness means lossless capture of the complete validated
  adapter event stream. A model request body is represented by its canonical
  summary hash and size metadata fixed in section 6; Assay does not claim to
  capture provider-private bytes the adapter contract does not transmit.

AGENT_COMPATIBILITY.md remains the publication home required by FR-ADAPT-001
and must be reconciled to this shape before R1 acceptance. Its conflicting
draft fields and semantics are superseded by this ADR; its tier explanations,
black-box boundary, conformance intent, and subprocess trust model continue to
apply where they do not conflict.

This is a pre-publication correction to major 1, not a deployed in-major
break: no Assay adapter implementation, package, release, or accepted R1
evidence existed when this ADR was accepted. After R1 freezes and publishes
the schemas, any incompatible wire change requires `assay-adapter/2` and a new
ADR as ADR-0005 requires.

## Alternatives Considered

- Implement the AGENT_COMPATIBILITY draft unchanged: rejected because it
  conflicts with Product's stable error category and Build's required unknown
  frame, stderr, malformed-frame, and termination evidence.
- Publish both shapes under major 1: rejected because negotiation could not
  identify which required fields or lifecycle an adapter implements.
- Rename the Architecture shape to major 2 now: rejected because major 1 has
  never been implemented or published, while Product and every R1 acceptance
  contract explicitly require the first published contract to be
  `assay-adapter/1`.
- Merge selected fields from both drafts: rejected because it would invent a
  third wire format not specified or tested anywhere in the planning set.

## Consequences

R1 can freeze one strict schema and supervisor behavior with no silent choice
between documents. The compatibility guide must be brought into mechanical
agreement and its examples regenerated from the published fixtures. Request
content beyond the contract's bounded summary is not available for scoring;
reports and trajectory documentation must describe that limit honestly.
