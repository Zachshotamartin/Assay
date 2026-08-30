# ADR-0009: Provider-Reported Usage as Cost Source of Truth

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-BUD-001, FR-BUD-003, FR-BUD-005,
  FR-ADAPT-008, NFR-COST-002, NFR-COST-003

## Context

Assay's second distinguishing claim is that cost budgets are blocking
pass/fail checks (FR-BUD-002). A budget gate is only as honest as the
number it compares, and there are two candidate sources: what the provider
says the request cost (usage fields in the API response, relayed by the
adapter per FR-ADAPT-008) and what the harness computes from its own
tokenizer counts and a pricing catalog. They disagree in practice —
tokenizer drift, cached-token discounts, and pricing changes all produce
divergence — so the source of truth, the cross-check, and the behavior on
disagreement must be fixed before R3 and R5 can be planned.

## Decision

Provider-reported usage (tokens and, where given, dollar cost) is
authoritative. The adapter reports usage per model request; the harness
independently derives an estimate from a versioned pricing catalog.
Reconciliation runs per model request and per run: a relative token
discrepancy greater than 1% or a dollar discrepancy greater than $0.01
marks the run `usage_unreconciled`. Unreconciled runs fail budget gates
closed — an unreconciled run cannot pass a cost budget (FR-BUD-003).
Synthetic and simulated runs report zero cost with `source: synthetic`
and are excluded from spend reports by default.

## Alternatives Considered

- Harness-side estimation as the source of truth: rejected because the
  provider's meter is what actually bills; a budget gate passing on a
  local estimate while the invoice disagrees defends nothing. Tokenizer
  versions drift from deployed models, and features like prompt caching
  make local token counts systematically wrong.
- Trusting provider numbers with no independent check: rejected because a
  buggy adapter mapping or a provider response with missing usage fields
  would silently zero out cost, letting a runaway suite pass its dollar
  budget; the derived estimate exists to catch exactly this.
- Warning on discrepancy instead of failing closed: rejected because a
  warning on a cost gate is a gate that does not gate; FR-BUD-005 requires
  that a cost regression blocks the build, and an advisory discrepancy
  path is the loophole through which every real overrun would flow.
- A tighter tolerance (exact match): rejected because providers round
  reported dollar amounts and cached-token accounting legitimately
  varies; exact matching would mark honest runs unreconciled and train
  users to ignore the state.

## Consequences

Budget verdicts cite a number that matches the provider invoice, the
`--dry-run` spend ceiling (NFR-COST-003) uses the same versioned pricing
catalog, and the nightly paid smoke test's $5 ceiling (NFR-COST-002) is
enforced by the same fail-closed machinery Assay ships to users.

The costs: the pricing catalog is a maintenance treadmill — every
provider price change requires a catalog version bump, and a stale
catalog shows up as reconciliation failures rather than silent error,
which is the intended failure direction. The 1% / $0.01 thresholds are
calibrated guesses and must be revisited with R3 evidence: if recorded
real-provider fixtures (NFR-DET-006) show honest variance exceeding the
thresholds for any supported provider, the tolerance change is a new ADR
with the observed distributions attached.
