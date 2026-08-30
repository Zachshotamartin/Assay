# ADR-0006: Fixed-N Frequentist Statistical Method

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-STAT-001 through FR-STAT-012,
  FR-RUN-001, NFR-MAINT-002

## Context

Assay's central claim is that it refuses to call a difference a regression
without a defensible test. The statistical method must therefore be fixed
before METHODOLOGY.md, the wording contract (FR-STAT-007), or the R6 gate
can be specified. The operating environment is hostile to statistical
subtlety: CI pipelines are re-run on flaky infrastructure, engineers
re-trigger jobs while watching results, and a blocked PR ends in a dispute
where the author demands to know exactly why. The method must survive all
three, which constrains the design more than statistical efficiency does.

## Decision

Frequentist, fixed-N design. Per-task pass rates carry 95% Wilson score
intervals; per-task variant deltas use Newcombe hybrid score intervals
with a two-sided Boschloo exact test (Fisher exact as the documented
fallback implementation); suite-level delta uses a stratified
paired-by-task bootstrap (BCa, 10,000 resamples, seeded); multiple
comparisons are controlled with Benjamini–Hochberg FDR at q = 0.05 across
the per-task tests in one comparison. Defaults: alpha = 0.05, power target
0.8, n = 10 runs per task per variant, minimum n = 5 for any wording
stronger than "insufficient data". Every report names the test and states
the minimum detectable effect for the n actually used (FR-STAT-005).

## Alternatives Considered

- Sequential testing (group-sequential or always-valid inference):
  rejected because CI re-runs and peeking break it in practice. Sequential
  methods spend an error budget across an ordered sequence of looks, but a
  re-triggered pipeline replays looks with no memory of the ones already
  taken, and an engineer re-running a job until it goes green is exactly
  the optional-stopping behavior the error-spending function must account
  for and cannot see. Error spending across independently retriggered
  pipelines is unenforceable, so the advertised false-positive rate would
  be fiction. Fixed N with every run recorded (FR-RUN-009) makes a re-run
  a new comparison, not a hidden extra look.
- Bayesian comparison (posterior probability of regression against a
  threshold): rejected because prior selection becomes an unauditable knob
  in a gate that must be contestable. Whoever sets the prior tunes how
  often the gate fires, and in a blocked-PR dispute "the posterior
  crossed 0.95 under our prior" invites relitigating the prior itself. A
  p-value under a named exact test with FDR control is defensible by
  citation; a prior is defensible only by authority.
- Plain two-proportion z-test per task: rejected because at n = 10 per arm
  the normal approximation is unreliable near rate boundaries of 0 and 1,
  precisely where agent tasks live; Boschloo retains exactness and
  uniformly dominates Fisher in power.

## Consequences

Every emitted claim is reproducible from stored counts, a seed, and a
named procedure, and the wording contract can enumerate its four permitted
phrases (FR-STAT-007). Statistical self-validation fixtures with injected
effects and pure noise gate R6 (FR-STAT-008).

The costs: fixed N buys validity with spend — detecting small effects
needs the published power/MDE tables (FR-STAT-012) and larger n, and the
harness will honestly say "insufficient data" where a looser tool would
declare a winner. Revisit only if 1.0 usage shows teams routinely need
mid-suite early stopping; that would require an always-valid method with
enforced run-registry accounting, and it is a new ADR.
