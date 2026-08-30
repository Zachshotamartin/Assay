# ADR-0007: Judge Model Policy

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-JUDGE-001 through FR-JUDGE-010,
  FR-ASSERT-006, FR-ASSERT-007, NFR-SEC-003

## Context

Some quality dimensions of a trajectory (explanation clarity, appropriate
caution) resist deterministic assertion, which makes LLM-as-judge scoring
unavoidable for part of the surface. But a judge is a stochastic measuring
instrument with two known failure modes: unvalidated agreement with human
judgment, and self-preference bias when the judge shares a model family
with the subject. In a harness whose product is a blocking CI gate, an
uncalibrated or biased judge converts both failure modes into wrongly
blocked or wrongly passed pull requests. The policy must be fixed before
R7 planning and before FR-ASSERT-006 can specify what the loader rejects.

## Decision

A judge assertion is valid ONLY with (a) a written rubric checked into the
suite, (b) a calibration set of at least 50 human-labeled trajectory
excerpts with documented labeling provenance, and (c) reported
judge-to-human agreement — percent agreement and Cohen's kappa — where
kappa >= 0.6 is required before the assertion may gate; below that it
reports advisory-only (FR-JUDGE-004). The judge model must be a different
model family from the subject agent's model by default; same-family
judging requires `allow_same_family_judge: true` in the suite and is
flagged in every report that includes the judged result. Judge input is
delimited, provenance-labeled, and instruction-stripped per METHODOLOGY.md
§judge; a red-team manipulation suite is a release gate at R7. Judge
non-determinism is handled by k = 3 majority vote with the vote
distribution stored (FR-JUDGE-009).

## Alternatives Considered

- Uncalibrated judging (rubric only, no human agreement measurement):
  rejected because an agreement-free judge is an unvalidated instrument;
  a gate that blocks PRs on it cannot answer "how often does this judge
  agree with a human?" and is indefensible in a dispute.
- Allowing same-family judging by default: rejected because
  self-preference bias is documented across judge evaluations, and the
  bias flows silently into pass rates; requiring an explicit flagged
  override preserves the option while making the risk visible on every
  surface that shows the verdict (FR-ASSERT-007).
- Human review instead of model judges: rejected as the default because
  it cannot run in CI at n = 10 runs per task per variant; humans instead
  supply the calibration labels that make the model judge auditable.
- Banning judges entirely: rejected because it silently narrows the
  measured surface to what deterministic checks can express, and teams
  would bolt on uncalibrated judging outside the harness anyway.

## Consequences

Judge verdicts always travel with their agreement metadata, and rubric
plus calibration version together — an edited rubric invalidates the
agreement measurement until recalibration (FR-JUDGE-010). Judge calls are
cost-accounted and budget-gated like any provider call (FR-JUDGE-008).

The costs: standing up a judged assertion requires real human labeling
work before it can gate, which is intentional friction. The kappa
threshold of 0.6 and the family-separation default must be revisited when
the R7 red-team suite produces evidence — if manipulation succeeds at
kappa 0.6, the gate tightens; and the model-family taxonomy underlying
"different family" must be re-examined whenever the provider catalog adds
families with shared lineage. Each change is a new ADR.
