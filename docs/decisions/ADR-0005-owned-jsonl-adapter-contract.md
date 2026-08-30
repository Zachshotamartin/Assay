# ADR-0005: Assay-Owned JSONL Adapter Contract

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-ADAPT-001 through FR-ADAPT-010,
  FR-TRAJ-005, NFR-DET-005, FR-ADAPT-008

## Context

Assay must talk to agents it does not control: Robin first, arbitrary
coding agents later. Robin already publishes a provider abstraction
(`ModelProviderAdapter`) and `@guard/*` packages, so the tempting shortcut
is to reuse them. The decision is needed now because the adapter contract
shape constrains the trajectory record schema (FR-TRAJ-005), the
conformance suite (FR-ADAPT-002), and the simulated agent that proves
harness logic with zero external dependencies (FR-ADAPT-003).

## Decision

Assay OWNS a minimal adapter contract and does NOT import Robin's provider
abstraction or `@guard/*` packages. An adapter is a subprocess speaking
newline-delimited JSON events on stdout under the versioned
`assay-adapter/1` contract (handshake, events, termination; schema in
AGENT_COMPATIBILITY.md). The Robin reference adapter wraps `robin --print`
with stream-JSON output, maps Robin's events onto the contract, and pins
the exact preview spelling it was tested against
(`--output-format stream-json`). The in-repo `adapter-simulated` scripted
agent proves harness logic with no external dependency.

Robin's provider abstraction is not reused because it models the wrong
thing: `ModelProviderAdapter` is Robin's port for a model provider it
calls, while Assay needs a contract for an agent under test that it
observes. Reusing it would smuggle the subject's internal vocabulary into
the harness's measurement schema and bind Assay's event union to a
dependency it must remain able to disagree with.

The subprocess boundary is a trust boundary, deliberately. The subject
runs in its own process inside the sandbox (FR-ADAPT-009): it cannot reach
harness memory, monkey-patch the scorer, or observe assertions before they
run. Everything the harness believes about a run arrives as frames it
validates; malformed frames and stderr are captured, bounded, and
classified, never trusted (FR-ADAPT-005). A harness that links its subject
in-process can make none of these claims.

## Alternatives Considered

- Linking Robin in-process as a library: rejected because it couples the
  two release cadences — every Robin refactor becomes an Assay build break
  — and violates the subject/harness trust boundary described above.
- Reusing Robin's `ModelProviderAdapter` port: rejected because it models
  a provider, not an agent under test; its completion-request surface has
  no vocabulary for turns, tool calls, or autonomous-subject termination.
- Adopting OpenTelemetry spans as the contract: rejected because span
  semantics carry no conformance tiering, no handshake or version
  negotiation (FR-ADAPT-010), and no per-request usage and cost fields
  (FR-ADAPT-008) without profile conventions Assay would own anyway.

## Consequences

Any agent in any language integrates by emitting JSONL, and the
conformance suite can assign tiers mechanically (FR-ADAPT-002). Harness
logic is provable against `adapter-simulated` alone, keeping required CI
deterministic and free (NFR-DET-005).

The costs: Assay maintains its own contract versioning discipline, and
the Robin adapter tracks a preview surface. Robin's automation contract
stabilizes at Robin's R7 gate; until that freeze the adapter's tier is
"pinned-preview", and it must be re-verified against the frozen contract
at Robin's R7 — a named checkpoint, not best-effort. A v2 contract is a
new ADR with negotiated major-version rejection per FR-ADAPT-010.
