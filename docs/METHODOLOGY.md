# Assay Methodology: The Statistical Contract

Document status: normative statistical specification. Last revised: 2026-08-30.

This document is the single normative authority for every statistical
definition, formula, threshold, and permitted result wording in Assay. Where
any other document, report template, or code comment disagrees with this
document on a statistical matter, this document controls, subordinate only to
the accepted ADRs it elaborates (ADR-0006, statistical method; ADR-0007, judge
model policy; ADR-0009, cost accounting source of truth).

Implementation status: R0 is accepted and R1 has branch-local code and local
evidence in progress. Neither implements statistical comparison or judge
capability. Every mechanism in this document remains `planned`; the acceptance
evidence for each lives in BUILD_PLAN.md gates R6 (statistical comparison) and
R7 (judge assertions).

Rules of this contract:

- Every statistical claim in this document appears with its formula, the
  assumptions under which the formula is valid, and the concrete condition
  under which it is invalid. A claim without all three is a defect in this
  document.
- The reporting layer may only emit the verbatim result phrases defined in
  §12. Any other comparative wording in an Assay report is a bug with the
  same severity as a wrong number.
- Constants in this document are the constants. Code that hard-codes a
  different alpha, n, B, q, or kappa threshold is nonconformant.

## 1. Why a single run proves nothing

An agent run is a draw from a distribution, not a measurement of a constant.
Two executions of the same task, same prompt, same model, same harness commit
can and do produce different trajectories and different pass/fail outcomes.
Treating one draw as the value of the underlying quantity is the foundational
error this harness exists to prevent.

### 1.1 Sources of run-to-run variance

Variance enters an agent evaluation through at least the following channels.
None of them can be fully eliminated; all of them must be modeled.

- Sampling temperature. Any temperature above zero makes token selection
  explicitly stochastic. A single sampled token early in a trajectory can
  change which tool is called first, which changes everything downstream.
- Provider-side nondeterminism at temperature zero. Temperature zero does not
  mean determinism. Providers batch requests, and batch composition changes
  floating-point reduction order; different accelerator hardware and kernel
  versions produce different low-order bits; mixture-of-experts routing can
  be load-dependent; and providers update models behind stable model IDs.
  Assay records the provider-reported model identity per request
  (FR-ADAPT-008) precisely because "same model string" is not evidence of
  "same model".
- Tool-environment timing. Agents that run commands race against the wall
  clock: a test suite that flakes under load, a package install that hits a
  slow mirror, a subprocess that is killed by a timeout on the slow tail of
  its latency distribution. The sandbox bounds these effects (ADR-0004) but
  cannot remove them.
- Flaky fixtures. A fixture whose own test suite is nondeterministic, whose
  behavior depends on the date, or whose state leaks between runs converts
  harness noise into apparent agent behavior.

### 1.2 The core rule

Because a single outcome is one draw from an unknown distribution, Assay
enforces one rule everywhere a quality claim could appear:

> N runs, rates, intervals, tests — or silence.

Concretely: every comparing surface shows pass rates over n runs, never
single-run booleans (FR-STAT-001); every rate carries its interval
(FR-STAT-002); every delta carries its test (FR-STAT-003); and anything that
cannot meet those requirements is displayed with the label defined in §12.4
("single observation — not evidence") and is barred from comparison wording.

Invalidation condition for everything that follows: all methods in this
document estimate properties of the run distribution under a fixed
configuration. If the configuration is not fixed — task content drifted,
model identity changed mid-comparison, harness version differs between the
arms — the estimates describe nothing. FR-STAT-010 therefore aborts any
comparison whose task content hashes differ between baseline and candidate,
with the stable error `comparison_invalid`.

## 2. Sampling design

### 2.1 Defaults and minimums

- Default sample size: n = 10 runs per task per variant (`assay run -n 10`
  is the built-in default).
- Minimum for comparative wording: n = 5 per task per variant in both arms.
  Below n = 5 in either arm, the only permitted comparison output is the
  verbatim phrase "insufficient data for comparison (n < 5)" (§12).
- Every source of harness randomness — run ordering, bootstrap resampling,
  simulated-agent behavior — is seeded, and every seed is recorded in the
  run record and the comparison report (NFR-DET-002, FR-RUN-007,
  FR-STAT-009).

n = 10 is a floor for gating, not a recommendation for precision. §7 shows
that n = 10 detects only large effects per task; teams that need to resolve
smaller effects must raise n and pay the corresponding cost, which
`assay run --dry-run` estimates in advance (NFR-COST-003).

### 2.2 The i.i.d. Bernoulli assumption, stated explicitly

For a fixed task, variant, and configuration, Assay models the n run outcomes
as independent and identically distributed Bernoulli trials:

```text
X_1, ..., X_n  i.i.d.  Bernoulli(p)

X_i = 1 if run i passes the task's assertions, 0 otherwise
p   = the (unknown) probability that a run of this task passes
```

Every interval and test in §3–§6 inherits this assumption. It is an
assumption, not a fact, and the harness must both state it and defend it,
because each of the following realistic conditions breaks it:

- Provider model silently updated mid-run ("identically distributed" fails).
  If the provider swaps model weights behind the same model ID partway
  through a batch of runs, the first k runs and the last n − k runs are
  draws from different distributions, and p is not a single number.
  Mitigation: Assay records provider-reported model identity and any
  provider-exposed version or fingerprint field on every model request
  (FR-ADAPT-008) and stamps them into the run record (FR-RUN-007). A
  comparison whose arms contain mixed model identities for the same declared
  variant is aborted with `comparison_invalid`, the same fail-closed
  behavior as task-content drift (FR-STAT-010). Version pinning is recorded;
  it cannot prevent a silent provider change, but it guarantees the change
  is detected and the affected comparison refuses to render a verdict
  rather than averaging over two different models.
- Shared rate-limit throttling correlating failures ("independent" fails).
  If runs share a provider rate-limit bucket, one run's burst can push
  sibling runs into 429s, timeouts, or degraded latency; failures then
  arrive in correlated clumps and the effective sample size is smaller than
  n. Mitigation: provider rate-limit errors are classified as
  `provider_rate_limit` infrastructure errors, never as task failures
  (FR-RUN-003), so throttling cannot masquerade as agent behavior; the
  runner bounds concurrency (FR-RUN-005); and each run executes in its own
  sandbox with its own subprocess so no in-process state is shared
  (FR-SAND-001, FR-SAND-012).
- Fixture state leakage between runs ("independent" and "identically
  distributed" both fail). If run i can mutate state that run i + 1
  observes — a shared scratch directory, a lingering daemon, a poisoned
  cache — later runs are conditioned on earlier ones. Mitigation:
  sandbox-per-run isolation. Every run materializes its fixture from a
  content-addressed archive into a dedicated container with a private
  workdir volume, and the container and volume are destroyed after the
  workspace snapshot is taken (FR-SAND-002, FR-SAND-006, FR-SAND-012). No
  filesystem state survives from one run to the next by construction.
- Time-of-day and ordering effects (a slow drift in "identically
  distributed"). Provider load, mirror latency, and host contention vary
  over the wall clock. If all baseline runs execute before all candidate
  runs, that drift becomes a confound aliased with the variant effect.
  Mitigation: run-order randomization across tasks and variants — the
  runner interleaves task runs across the comparison arms using the
  recorded seed, so temporal drift spreads across both arms instead of
  loading onto one.

Residual honesty: these mitigations reduce and detect dependence; they do
not prove independence. The self-validation suite (§10) quantifies how the
declared error rates behave under the modeled assumptions; it cannot certify
behavior under arbitrary unmodeled dependence. This is a stated limitation
of the method, not a hidden one.

### 2.3 What a "run" is

A run is one complete execution of one task by one variant through the run
state machine, terminating in a scored outcome of `pass` or `fail`. Runs
whose terminal state is `failed_infrastructure`, `timed_out` (at the
infrastructure level, as distinct from a task-declared budget), `cancelled`,
or `quarantined` are excluded from k and from n: infrastructure error is
never scored as task failure (FR-RUN-003). A report always shows the number
of excluded runs next to n, because an n that silently shrank is a lie about
precision.

## 3. Per-task estimation

### 3.1 Point estimate

The per-task pass rate for one variant is the sample proportion:

```text
p̂ = k / n

k = number of passing runs
n = number of scored runs (infrastructure errors excluded, §2.3)
```

Assumptions: the i.i.d. Bernoulli model of §2.2. Invalid when: any of the
conditions in §2.2 hold; in particular, if runs are not exchangeable (the
distribution of outcomes changes over the sequence, or outcomes are
correlated), p̂ still equals k/n arithmetically but no longer estimates a
well-defined single p, and the interval below is meaningless.

### 3.2 95% Wilson score interval

Every rendered pass rate carries a 95% Wilson score interval (FR-STAT-002):

```text
             p̂ + z²/(2n)  ±  z · sqrt( p̂(1−p̂)/n  +  z²/(4n²) )
CI_Wilson =  ─────────────────────────────────────────────────────
                              1 + z²/n

z = z_{1−α/2} = 1.959964  (alpha = 0.05, two-sided)
```

At the boundaries this evaluates to honest, non-degenerate intervals; for
example at k = 0, n = 10 the interval is approximately [0.000, 0.278], and
at k = n = 10 approximately [0.722, 1.000].

### 3.3 Why Wilson, and not Wald or Clopper–Pearson

- Not Wald. The Wald interval `p̂ ± z·sqrt(p̂(1−p̂)/n)` degenerates to a
  zero-width interval at k = 0 and k = n — precisely the cases a small-n
  agent eval hits constantly (a task that passed 10/10 times is not known
  to pass with certainty). Wald's actual coverage also oscillates far below
  the nominal 95% for small n and p near 0 or 1. It is forbidden in Assay.
- Not Clopper–Pearson. The "exact" Clopper–Pearson interval guarantees
  coverage ≥ 95% by inverting the exact binomial test, but at small n it
  substantially overcovers — its intervals are wider than needed, which in
  a gating context translates into failing to flag real regressions.
  Wilson's coverage stays close to nominal across p without the systematic
  width penalty, which is the better trade for a CI gate.

Assumptions: i.i.d. Bernoulli trials (§2.2). Invalid when: the trials are
not exchangeable — under correlated outcomes (shared throttling, state
leakage) the true coverage of the Wilson interval can be arbitrarily far
below 95%, and the interval must not be quoted. The mitigations in §2.2 are
what earn the right to print this interval.

## 4. Two-variant per-task comparison

A comparison evaluates one candidate variant against one baseline variant.
Per task, both arms hold n scored runs of the identical task content hash
(FR-STAT-010).

### 4.1 Effect estimate: difference in proportions

```text
Δ̂ = p̂_c − p̂_b = k_c/n_c − k_b/n_b

subscript b = baseline arm, c = candidate arm
```

Reports express Δ̂ in percentage points (pp). Sign convention: for pass
rates, negative Δ̂ is harmful. For metrics where lower is better (cost,
latency), the harmful direction is positive and the report says which
direction is harmful for every row.

### 4.2 Newcombe hybrid score interval for the delta

The 95% interval on Δ̂ is Newcombe's hybrid score interval, built from the
two single-proportion Wilson intervals (§3.2):

```text
Let (l_b, u_b) = Wilson 95% interval for p̂_b
Let (l_c, u_c) = Wilson 95% interval for p̂_c

lower = Δ̂ − sqrt( (p̂_c − l_c)²  +  (u_b − p̂_b)² )
upper = Δ̂ + sqrt( (u_c − p̂_c)²  +  (p̂_b − l_b)² )
```

Rationale: it inherits Wilson's good boundary behavior — it does not
collapse when either arm is at 0/n or n/n, which the Wald difference
interval does — and its coverage is close to nominal at the small n this
harness runs at.

Assumptions: the two arms are independent samples, each i.i.d. Bernoulli
(§2.2). Invalid when: either arm violates §2.2, or the arms are not
independent of each other (for example, baseline and candidate runs
interleaved through one shared rate-limit bucket that couples their
failures; the §2.2 mitigations apply across arms as well).

### 4.3 Significance: Boschloo exact test, Fisher fallback

Per-task significance uses a two-sided Boschloo exact test (ADR-0006).

Definition. Boschloo's test is an unconditional exact test for a 2×2 table.
It uses Fisher's exact p-value as its test statistic and computes
significance by maximizing over the unknown common pass probability π under
the null hypothesis H0: p_b = p_c = π:

```text
p_Boschloo = sup over π in [0, 1] of
             P( p_Fisher(K_b, K_c) ≤ p_Fisher(k_b, k_c)  |  H0, π )

K_b ~ Binomial(n_b, π),  K_c ~ Binomial(n_c, π), independent
```

Why Boschloo dominates Fisher for power at small n. Fisher's exact test
conditions on both table margins, but in this design only the row totals
(n_b, n_c) are fixed — the number of total passes is random. Conditioning
on a margin that is actually random discards information, and the discrete
conditional null distribution makes Fisher markedly conservative at small
n: its true size is well below alpha, so it needs a larger real effect to
reject. Boschloo's test is uniformly at least as powerful as Fisher's at
the same nominal alpha — it can only reject in a superset of cases — and
at n = 10 per arm the power difference is material.

Fisher exact as the documented fallback. Fisher's exact test (the
hypergeometric tail probability, two-sided by summation of tables at most
as probable as the observed one) is the permitted fallback implementation
if the Boschloo implementation is unavailable or fails its own validation
suite. The cost is stated plainly: Fisher is conservative, so the fallback
buys implementation simplicity at the price of reduced power — real
regressions near the detection threshold that Boschloo would flag will
sometimes pass silently under Fisher. Which test produced each p-value is
named in the report (FR-STAT-003); the fallback is never silent.

Assumptions: independent binomial arms with fixed n_b and n_c decided
before the data are seen (fixed-N design, ADR-0006). Invalid when: n was
chosen or extended after looking at results (peeking invalidates the size
guarantee — this is exactly why sequential designs were rejected and are
deferred, §14), or when the §2.2/§4.2 independence assumptions fail.

### 4.4 Pairing note

Runs are not naturally paired across variants: run 3 of the baseline has no
privileged relationship to run 3 of the candidate — they share no random
seed path, no sandbox, and no provider state. Assay therefore makes no
pairing claim at the run level, and the per-task comparison is an unpaired
two-sample comparison (§4.1–§4.3).

Pairing exists one level up: both variants run the same tasks, so the suite
is paired by task. The suite-level procedure (§5) exploits exactly that
task-level pairing and no more. Claiming run-level pairing that does not
exist would understate variance; ignoring task-level pairing that does
exist would overstate it. Assay does neither.

## 5. Suite-level comparison

The suite-level question — "did this change regress the agent overall?" —
is answered by an interval on the mean per-task pass-rate difference,
computed by a stratified paired-by-task bootstrap (FR-STAT-009).

### 5.1 Estimand

```text
Δ̄ = (1/T) · Σ over tasks t of ( p̂_c,t − p̂_b,t )

T = number of tasks compared (identical content hashes in both arms)
```

### 5.2 Algorithm

The bootstrap is stratified (resampling happens within each task's own
runs) and paired by task (a resampled task keeps both of its arms
together). Ordered steps:

1. Fix the PRNG. Seed a counter-based PRNG with the comparison seed. The
   seed is recorded verbatim in the comparison report (FR-STAT-009,
   NFR-DET-002); rerunning `assay compare` with the same stores and seed
   reproduces the interval bit-for-bit.
2. Compute the observed statistic Δ̄ from the real data (§5.1).
3. For each bootstrap replicate r in 1..B, with B = 10,000:
   1. Resample tasks with replacement: draw T task indices uniformly from
      the T compared tasks. A task drawn twice contributes twice — this is
      the outer, task-level stratum and captures between-task variance.
   2. Within each drawn task, resample runs with replacement: draw n_b
      outcomes from that task's baseline runs and n_c outcomes from that
      task's candidate runs, independently. This inner stratum captures
      within-task binomial variance. The pairing is preserved because both
      arms of a drawn task enter the replicate together.
   3. Compute the replicate statistic Δ̄*_r from the resampled data.
4. Form the BCa (bias-corrected and accelerated) interval from the B
   replicates, as sketched in §5.3.
5. Report Δ̄, the 95% BCa interval, B, and the seed.

Edge cases: a task with zero scored runs in either arm is excluded from T
and listed in the report's exclusion table with its reason; if T < 2 the
suite-level interval is not computed and the report says so (a bootstrap
over one task estimates nothing about between-task variance); replicates
in which every drawn task has zero variance are retained as-is (they are
legitimate draws, not failures).

### 5.3 BCa correction (formula sketch)

The naive percentile interval is biased when the statistic's distribution
is skewed — routine here, because per-task rates pile up near 0 and 1. BCa
corrects both bias and skew:

```text
Bias correction:
  z0 = Φ⁻¹( #{ r : Δ̄*_r < Δ̄ } / B )

Acceleration (jackknife over tasks; θ̂(i) = Δ̄ with task i deleted):
        Σ ( θ̄(·) − θ̂(i) )³
  a = ─────────────────────────────       θ̄(·) = mean of the θ̂(i)
      6 · [ Σ ( θ̄(·) − θ̂(i) )² ]^(3/2)

Adjusted percentile levels (z_α = Φ⁻¹(α)):
  α1 = Φ( z0 + (z0 + z_{0.025}) / (1 − a·(z0 + z_{0.025})) )
  α2 = Φ( z0 + (z0 + z_{0.975}) / (1 − a·(z0 + z_{0.975})) )

Interval = [ quantile_{α1} of Δ̄*,  quantile_{α2} of Δ̄* ]
```

Degenerate guard: if every replicate equals Δ̄ (all-constant data), z0 is
undefined; the report then states the interval as the point value with an
explicit "no resampling variance" marker instead of fabricating width.

### 5.4 Assumptions and invalidation

Assumptions: tasks are exchangeable within the suite — the suite is treated
as a sample of tasks from one population of interest, so resampling tasks
with replacement is meaningful; within each task, the §2.2 run model holds.

Invalid when: a suite deliberately mixes populations — for example, 40 easy
smoke tasks and 10 hard refactoring tasks composed on purpose. Resampling
such a mixture treats the composition itself as sampling noise, and the
"suite mean" is an artifact of an arbitrary mixing ratio. The required
remedy is stratified reporting by tag: `assay compare` groups tasks by
their declared tags (FR-TASK-006) and reports a per-tag suite delta with
its own bootstrap interval alongside, or instead of, the pooled number.
A pooled suite delta over a deliberately heterogeneous suite is reported
only with its per-tag breakdown attached.

## 6. Multiple comparisons

One comparison report runs one hypothesis test per task — 50 tasks means 50
tests. At alpha = 0.05, pure noise would flag about 2.5 tasks per 50-task
report. Uncorrected per-task p-values are therefore never used for gating.

### 6.1 Procedure: Benjamini–Hochberg FDR at q = 0.05

Assay controls the false discovery rate across the per-task tests within
one comparison report using the Benjamini–Hochberg step-up procedure at
q = 0.05 (FR-STAT-004). Ordered steps:

1. Collect the m per-task raw p-values from §4.3 for this comparison
   (m = number of tasks tested; tasks excluded per §5.2 contribute no
   test).
2. Sort ascending: p_(1) ≤ p_(2) ≤ ... ≤ p_(m).
3. Find the largest rank kmax such that:

   ```text
   p_(kmax) ≤ (kmax / m) · q        with q = 0.05
   ```

4. Reject the null hypothesis for the tasks with ranks 1..kmax. If no rank
   satisfies the inequality, nothing is rejected.
5. Compute the adjusted value for every task (monotone step-up):

   ```text
   q_(i) = min over j ≥ i of  min( 1,  m · p_(j) / j )
   ```

6. Report, for every task row: the raw p and the adjusted q, side by side
   (FR-STAT-004). A task "fires" if and only if q_(i) ≤ 0.05.

### 6.2 Why FDR and not FWER

Family-wise error control (Bonferroni: test each task at alpha/m) bounds
the probability of even one false alarm, at devastating cost to power: on a
50-task suite Bonferroni tests each task at 0.001, which pushes the
per-task MDE at n = 10 close to the maximum possible effect — the gate
would be blind to almost everything.

A CI gate does not need "probably zero false alarms ever"; it cares about
the expected fraction of its alarms that are false, because each alarm
costs a bounded amount of engineer attention. BH at q = 0.05 guarantees
that, in expectation, at most 5% of the tasks a report flags are noise —
the right guarantee at far higher power.

Assumptions: BH controls FDR exactly under independent per-task tests, and
remains valid under positive regression dependence among them (the
plausible direction here: a globally bad model change pushes many tasks the
same way). Invalid when: tests are strongly negatively dependent, where BH's
guarantee can degrade; and, as always, when the underlying per-task tests
are themselves invalid (§4.3). The suite-level bootstrap gate (§5) is
deliberately independent of the per-task FDR machinery, so a pathology in
one does not silently corrupt the other.

## 7. Minimum detectable effect and power

A test that cannot detect the effect you care about returns "no significant
difference" no matter what the truth is. Reporting a non-detection without
reporting detectability is how underpowered evaluations launder regressions.
Assay refuses to do it.

### 7.1 Power formula (normal approximation with Cohen's h)

For two independent proportions with n runs per arm, Assay uses the
arcsine-transform normal approximation:

```text
Effect size (Cohen's h):
  h = 2·asin( sqrt(p1) ) − 2·asin( sqrt(p2) )

Required n per arm for two-sided alpha and power 1−β:
  n = ( (z_{1−α/2} + z_{1−β}) / h )²

Equivalently, the detectable effect size at a given n:
  h_min = (z_{1−α/2} + z_{1−β}) / sqrt(n)

Constants used throughout:
  alpha = 0.05 (two-sided)  →  z_{1−α/2} = 1.959964
  power = 0.8               →  z_{1−β}   = 0.841621
  z_{1−α/2} + z_{1−β} = 2.801585
```

The minimum detectable effect (MDE) in percentage points at baseline p1 is
obtained by inverting h_min:

```text
φ1 = 2·asin( sqrt(p1) )
p2 = sin²( (φ1 − h_min) / 2 )        (harmful direction: p2 < p1)
MDE = (p1 − p2) · 100 pp
```

### 7.2 MDE tables (alpha = 0.05, power = 0.8)

Computed from the formulas above with h_min = 2.801585 / sqrt(n). These
tables are published here and must be recomputed by the same code CI uses
(FR-STAT-012); a divergence between this table and the shipped `stats`
package is a release-blocking defect.

Baseline p1 = 0.5 (a coin-flip task; symmetric in direction):

| n per arm | h_min  | Detectable p2 | MDE (pp) |
| --------- | ------ | ------------- | -------- |
| 5         | 1.2529 | 0.025         | 47.5     |
| 10        | 0.8859 | 0.113         | 38.7     |
| 20        | 0.6265 | 0.207         | 29.3     |
| 50        | 0.3962 | 0.307         | 19.3     |
| 100       | 0.2802 | 0.362         | 13.8     |

Baseline p1 = 0.8 (a mostly-passing task; harmful direction, p2 < p1):

| n per arm | h_min  | Detectable p2 | MDE (pp) |
| --------- | ------ | ------------- | -------- |
| 5         | 1.2529 | 0.214         | 58.6     |
| 10        | 0.8859 | 0.380         | 42.0     |
| 20        | 0.6265 | 0.509         | 29.1     |
| 50        | 0.3962 | 0.622         | 17.8     |
| 100       | 0.2802 | 0.678         | 12.2     |

Directional note: at p1 = 0.5 the MDE is symmetric. At p1 = 0.8 it is not —
the arcsine scale compresses near 1, so an improvement of about 20.0 pp
(0.8 → 0.9996) is detectable at n = 10 while a regression must be 42.0 pp
to reach the same power, and at n = 5 no improvement from 0.8 is detectable
at all (the required p2 exceeds 1). Reports state MDE for the harmful
direction, which is the direction a gate must not be blind to.

Read the n = 10 rows honestly: at the default sample size, a per-task test
reliably detects only catastrophic per-task regressions (roughly 39–42 pp).
Smaller but real suite-wide regressions are caught by the suite-level
bootstrap (§5), which aggregates across tasks; §10.2 quantifies exactly
that division of labor.

Assumptions: the normal approximation on the arcsine scale; independent
arms; fixed n. The approximation is anti-conservative by a few percent at
n = 5 relative to exact power, and the actual test used is Boschloo (§4.3),
whose exact power differs slightly from this approximation. The table is a
planning and honesty device, not a substitute for the exact test. Invalid
when: quoted for a test other than the §4.3 tests, or for arms of unequal n
without using the harmonic-mean n per arm.

### 7.3 The honesty rule

Every comparison report states the MDE for its actual n, computed at the
observed baseline rate of each task (FR-STAT-005). The "no significant
difference" wording in §12 embeds it verbatim. An underpowered suite must
say so: if the configured regression threshold (the delta the gate is meant
to catch) is smaller than the MDE at the actual n, the report carries the
line "this comparison cannot detect the configured threshold at n = N" and
the CI annotation marks the gate as underpowered rather than passing it
silently. Silence about power is treated as a wording-contract violation
(§12.5).

## 8. Flake classification

Instability is a measurement about a task, and it gets the same statistical
discipline as everything else (FR-STAT-006). The word "flaky" is banned from
reports (§12.5); only the classes below may be emitted.

### 8.1 Classes

Per task, per variant, over n scored runs with k passes:

- `always_pass`: k = n. Note that this is an observation, not a proof — at
  n = 10, `always_pass` is compatible with any true p ≥ 0.72 (§3.2).
- `always_fail`: k = 0. Symmetrically compatible with any true p ≤ 0.28 at
  n = 10.
- `unstable`: 0 < k < n. The task was observed to both pass and fail.

### 8.2 The `genuinely_unstable` label

`unstable` at small n is weak evidence — 9/10 could be a true p of 0.999
on an unlucky day. The stronger label `genuinely_unstable` requires both:

- n ≥ 10, and
- the task's 95% Wilson interval (§3.2) excludes both 0 and 1.

This guarantees the data are statistically incompatible with "actually
always passes" and "actually always fails" before Assay asserts that the
task itself is bimodal. Invalid when: the §2.2 assumptions fail — a task
that "flaked" because a shared rate limit clipped three runs is not
unstable, which is why infrastructure errors never enter k or n (§2.3).

### 8.3 Cross-variant instability

A task classified `unstable` in both arms of a comparison is flagged
`unstable_in_both_variants` in the flake table. Such a task inflates the
variance of the comparison while carrying little signal about the variant
difference; the flake table exists so a reviewer can see how much of a
"no significant difference" verdict is attributable to noisy tasks rather
than to genuine equivalence.

### 8.4 Remediation flow

The recommended remediation is quarantine, not deletion:

1. Tag the task `quarantined` in the suite file (a normal tag per
   FR-TASK-006). Quarantined tasks still run and still record results.
2. Quarantined tasks are excluded from gate verdicts and shown in a
   separate report section, so the history needed to diagnose the
   instability keeps accumulating instead of being destroyed.
3. Fix the underlying cause (fixture nondeterminism, timing sensitivity,
   underspecified assertion), then remove the tag. The task's subsequent
   classification history documents whether the fix worked.

Deleting an unstable task destroys the evidence of instability and
silently shrinks suite coverage; Assay's documentation never recommends it.

## 9. Budget statistics

Budgets (FR-BUD-001) evaluate cost and latency across the n runs of a task
or suite, never against a single run (FR-BUD-004).

### 9.1 What a budget evaluates

A budget declares its statistic: `median` (default) or `p95`, computed over
the per-run values of the budgeted quantity (total tokens, wall-clock ms,
tool-call count, dollar cost). Definitions over the sorted per-run values
x_(1) ≤ ... ≤ x_(n):

```text
median:  x_((n+1)/2) for odd n; the mean of x_(n/2) and x_(n/2+1) for even n

p95:     x_(r) with r = max(1, floor(0.95 · n))
         (deterministic order-statistic rank; no interpolation)
```

The rank definition is deliberately non-interpolating so that budget
verdicts are byte-reproducible from stored run data (FR-RUN-004).

### 9.2 The p95-at-n=10 caveat

At n = 10, r = floor(9.5) = 9: the p95 of 10 samples is the 2nd-largest
order statistic. A statistic determined by the top two observations of ten
has wide sampling error — a single provider hiccup relocates it, and its
own sampling distribution spans a large chunk of the underlying tail.
Consequences, stated in every report that shows a p95 at n < 20:

- Recommendation: use n ≥ 20 for any p95 budget; below that, declare the
  budget on `median`, which is stable at n = 10.
- A p95 budget verdict at n < 20 carries the printed caveat
  "p95 estimated from n = N runs; tail estimate is unstable below n = 20"
  and is reported, but teams are advised in TASK_FORMAT.md not to gate on
  it.

Assumptions: per-run costs and latencies are i.i.d. draws (§2.2 applies to
these continuous quantities as much as to pass/fail). Invalid when: latency
is autocorrelated across runs (provider warm-up, time-of-day drift) — the
order statistic is then an estimate of nothing stable; the run-order
randomization of §2.2 mitigates but does not eliminate this.

### 9.3 Reconciliation precondition

Budget evaluation consumes reconciled usage only (ADR-0009, FR-BUD-003). A
run marked `usage_unreconciled` (provider-reported and catalog-derived
usage diverging by more than 1% of tokens or $0.01) cannot pass a cost
budget and cannot contribute to any cost or spend claim in any report
(§12.4). Fail-closed: missing or unreconciled usage is treated as a breach,
never as zero cost.

## 10. Statistical self-validation

The harness proves its own statistics. The `stats` package does not merely
have unit tests; it is validated end-to-end against synthetic data with
known ground truth, and the validation is a release gate for R6
(FR-STAT-008).

### 10.1 Synthetic run generator

A seeded generator fabricates complete stored suite results — tasks, runs,
outcomes, per-run costs — from declared ground-truth parameters: per-task
true pass probabilities for baseline and candidate, injected effect sizes,
and injected instability. Because the generator writes through the same
run-store schema real runs use, the validation exercises the actual
comparison pipeline (`assay compare` on the stored data), not a private
code path.

### 10.2 Simulation protocol

For each scenario: 1,000 seeded simulations (seeds 1..1000 from a recorded
master seed), each simulation generating a fresh synthetic suite and
running the full comparison pipeline; the scenario asserts on the count of
simulations in which the pipeline emitted "regression detected".

Scenario S1 — true 30 pp suite-wide regression at n = 10. Ground truth: a
20-task suite, baseline true p = 0.8 per task, candidate true p = 0.5 per
task, n = 10 per arm. Assertion: the suite-level gate (§5) fires in ≥ 80%
of the 1,000 simulations. Note the division of labor this scenario proves:
per the §7.2 table, individual per-task tests at n = 10 are underpowered
for a 30 pp effect (MDE 42.0 pp at p1 = 0.8), and the detection is carried
by the suite-level bootstrap aggregating 20 tasks — the expected suite
detection rate is close to 100%, and 80% is the conservative floor the
gate asserts.

Scenario S2 — pure noise must not fire. Ground truth: same 20-task suite,
identical true p in both arms, n = 10. The declared false-positive rate of
the suite gate is 5%. Assertion with binomial tolerance: over 1,000
simulations at a true rate of 0.05, the firing count is Binomial(1000,
0.05) with mean 50 and standard deviation sqrt(1000 · 0.05 · 0.95) = 6.89;
the central 95% tolerance interval is approximately [37, 64] firings. The
gate asserts firings ≤ 64; a count below 37 does not fail the gate but is
logged as suspicious over-conservatism (it usually means the fallback
Fisher path is active, §4.3). A firing count above 64 is a
release-blocking defect in the statistics.

Scenario S3 — small 5 pp effect at n = 10 is usually NOT detected, and
that is asserted. Ground truth: 20 tasks, baseline p = 0.5, candidate
p = 0.45, n = 10. Per the §7.2 table the per-task MDE at n = 10 is
38.7 pp, so per-task detection is negligible; the suite-level gate's
approximate power for a 5 pp mean shift over 20 tasks at n = 10 is on the
order of 15–20%. Assertion: the pipeline emits "regression detected" in
≤ 40% of simulations, and emits the §12 "no significant difference"
wording — including the MDE statement — in the remainder. This scenario
exists to pin the honesty property: an effect below the MDE must usually
produce the calibrated non-claim, never a fabricated detection and never
silence about detectability.

All three scenarios are deterministic given the master seed and run in
required CI at zero provider cost (NFR-COST-001, NFR-DET-001).

### 10.3 Mutation-testing requirement

Simulation proves the pipeline's aggregate behavior; mutation testing
proves the tests can see the code. The `stats` package (with the scoring/
trajectory-metric package, per NFR-MAINT-002) must hold a mutation score of
≥ 85%: at least 85% of seeded mutants (operator swaps, boundary shifts,
constant perturbations — for example `≤` → `<` in the BH step, or 1.96 →
1.64 in the Wilson z) are killed by the test suite. A surviving mutant in
an interval or test formula is triaged as a missing test, not waved
through. The mutation gate is part of R6 acceptance evidence.

## 11. Judge calibration procedure

LLM-as-judge assertions import a second model's judgment into the gate;
uncalibrated, that is laundering one model's opinion through another. The
policy is fixed by ADR-0007; this section gives it statistical content.

### 11.1 Calibration set

A judge assertion is valid only against a rubric with a calibration set of
at least 50 human-labeled trajectory excerpts (FR-JUDGE-002). Labeling
provenance is recorded with the set: who labeled each item, against which
rubric version, when, and with what inter-labeler process (single labeler,
dual-label with adjudication). A calibration set without provenance is
rejected by `assay validate` exactly as a missing set would be.

### 11.2 Agreement metrics

Judge-to-human agreement is computed per rubric version × judge model pair
(FR-JUDGE-003) and stored:

```text
Percent agreement:
  p_o = (# items where judge verdict = human label) / N_items

Cohen's kappa:
  κ = (p_o − p_e) / (1 − p_e)

  p_e = expected chance agreement from the marginals
      = Σ over categories c of  P_judge(c) · P_human(c)
```

Why kappa and not percent agreement alone: on an imbalanced set (say 90%
of items labeled "pass"), a judge that answers "pass" unconditionally
scores p_o = 0.90 while measuring nothing. Kappa discounts chance
agreement.

Invalidity conditions for kappa, stated because kappa has famous
pathologies:

- Prevalence problem: when one category dominates, p_e is high and kappa
  can be low even for a judge with high accuracy — kappa is then a harsh
  but honest measure. Conversely, near-uniform marginals inflate kappa's
  apparent generosity.
- Marginal imbalance (bias) problem: kappa is affected by disagreement
  between the judge's and humans' marginal distributions, so two pairs
  with identical accuracy can have different kappas.

Mitigation: every reported kappa is accompanied by the label prevalence of
the calibration set and both marginal distributions, so a reader can see
whether a low kappa reflects a bad judge or a skewed set. A kappa quoted
without its prevalence is a wording-contract violation.

### 11.3 Gating threshold

κ ≥ 0.6 is required for a judge assertion to gate (FR-JUDGE-004). Below
0.6, the assertion runs and reports, labeled advisory-only, and cannot
change a pass/fail verdict or an exit code. The threshold is a floor of
"substantial agreement" on the conventional scale; it is a policy constant
of ADR-0007, not a statistical derivation, and this document says so
plainly rather than dressing it up.

### 11.4 Vote aggregation

Judge nondeterminism is handled by k = 3 independent judge calls per
assertion with a majority verdict; the full vote distribution (3–0 or 2–1,
per-vote raw outputs) is stored with the result (FR-JUDGE-009). A 2–1
verdict is rendered with its split visible wherever the verdict renders.
Judge calls are cost-accounted and budget-gated like any other provider
call (FR-JUDGE-008).

### 11.5 Drift and re-calibration triggers

Stored agreement is valid only for the exact (rubric version, judge model)
pair it was measured on. Re-calibration is mandatory — the stored kappa is
invalidated and the assertion drops to advisory — when either trigger
fires:

- the judge model version changes, including a provider-reported model
  fingerprint change behind a stable model ID (§2.2's silent-update
  problem applies to judges too); or
- the rubric changes in any way; rubric and calibration version together
  (FR-JUDGE-010).

### 11.6 Judge input isolation (summary)

The subject agent's output is adversarial input to the judge. Assay's
isolation transform — normative detail in THREAT_MODEL.md and BUILD_PLAN
gate R7 — requires that subject output enter judge prompts only inside
delimited blocks, carrying provenance labels, framed explicitly as
untrusted data to be evaluated and never as instructions to follow
(FR-JUDGE-006). A red-team manipulation suite (subject outputs attempting
to instruct, flatter, or prompt-inject the judge) runs in CI and its
detected-manipulation metrics are reported (FR-JUDGE-007, NFR-SEC-003).
Calibration measured on clean data says nothing about adversarial
robustness; that is why R7 requires both.

## 12. The wording contract

This section defines the exact and only phrases an Assay report may emit
for a comparison (FR-STAT-007). The reporting package renders these strings
from a closed enum; free-text comparative language does not exist in the
code path. Verbatim strings are shown quoted; N, X, and dates are the only
substitution points.

### 12.1 The four permitted result phrases

- "regression detected" — permitted if and only if the adjusted q ≤ 0.05
  for the relevant test (per-task: §6; suite gate: the §5 BCa interval
  excluding zero) AND the estimated delta lies beyond the configured
  threshold in the harmful direction. Emitting this phrase sets exit
  code 3.
- "improvement detected" — the same two conditions in the beneficial
  direction. Never affects exit codes; a gate blocks on harm, it does not
  reward luck.
- "no significant difference detected (minimum detectable effect at
  n=N: X pp)" — permitted only when both arms hold n ≥ 5, the test was
  actually run, and neither of the first two phrases qualifies. The MDE
  substitution is mandatory: this phrase without its parenthetical is a
  contract violation, because "no difference found" and "no difference
  findable" must never be conflated (§7.3).
- "insufficient data for comparison (n < 5)" — mandatory and exclusive
  whenever either arm holds fewer than 5 scored runs. No interval, test
  result, or delta is rendered alongside it.

### 12.2 Decision table

| Condition | Only permitted phrase |
| --- | --- |
| either arm n < 5 | "insufficient data for comparison (n < 5)" |
| q ≤ 0.05, delta beyond threshold, harmful | "regression detected" |
| q ≤ 0.05, delta beyond threshold, beneficial | "improvement detected" |
| anything else | "no significant difference detected (minimum detectable effect at n=N: X pp)" |

Note the deliberate asymmetry: a statistically significant delta that is
inside the configured threshold renders the "no significant difference"
phrase's row with its q value visible — the numbers are shown, but the
headline wording is reserved for effects that are both significant and
large enough to matter.

### 12.3 Mandatory qualifiers

- Judged results always carry, adjacent to the verdict in every surface
  that shows the verdict (FR-ASSERT-007, FR-JUDGE-007):
  "judge agreement κ=..., calibrated YYYY-MM-DD"
  with the kappa from §11.2 and the calibration date. If κ < 0.6 the
  qualifier is extended with "— advisory only" and the result cannot
  gate. Same-family judging (ADR-0007 override) adds its flag here.
- Unreconciled-usage runs cannot produce cost claims: any run marked
  `usage_unreconciled` is excluded from every cost figure, cost budget,
  and spend statement, and the report row shows "cost unavailable
  (usage unreconciled)" in place of a number (ADR-0009, FR-BUD-003).
- Single-run displays — anywhere exactly one run of something is shown,
  including the viewer — are labeled:
  "single observation — not evidence"
  and are barred from all four §12.1 phrases.

### 12.4 Forbidden phrases

The following may never appear in any Assay-generated report, comment, or
CI annotation. The reporting package's tests assert their absence against
the rendered output of every report fixture:

- "X is better than Y" (or "worse", "outperforms", "beats") without the
  accompanying test result — and even with a test, the permitted phrasing
  is the §12.1 enum, not free-text superlatives.
- "flaky" — the only permitted instability vocabulary is the §8 classes:
  `always_pass`, `always_fail`, `unstable`, `genuinely_unstable`,
  `unstable_in_both_variants`.
- "faster", "slower", "cheaper", "more expensive" without the interval or
  declared budget statistic (§9) attached to the specific numbers.
- "significant" applied to any comparison that did not run a §4/§5 test,
  and "proves", "confirms", or "guarantees" applied to any statistical
  result whatsoever.
- Any accuracy, pass-rate, or quality number rendered without its n.

### 12.5 Enforcement

The wording contract is enforced in code, not by review: report rendering
goes through typed result objects whose display strings are the §12.1
enum; golden-report fixtures cover every branch of the decision table; and
the forbidden-phrase scan runs over every rendered report artifact in CI.
A wording violation is a release-blocking defect of gate R6.

## 13. Reporting requirements

Every comparison report — Markdown or JSON (`assay report --format`), PR
comment, or viewer surface — must contain all of the following. A report
missing any item is nonconformant:

- n per task per arm, with the count of excluded (infrastructure-error)
  runs per §2.3.
- All seeds: the run seeds of both arms and the comparison/bootstrap seed
  (§5.2), sufficient to reproduce every number bit-for-bit.
- The name of every test used per row (Boschloo or Fisher-fallback, §4.3)
  and the suite-gate method (stratified paired-by-task BCa bootstrap,
  B = 10,000).
- Raw p and BH-adjusted q for every per-task test, side by side (§6.1).
- Intervals: the Wilson 95% interval for every rendered rate (§3.2), the
  Newcombe 95% interval for every per-task delta (§4.2), and the BCa 95%
  interval for the suite delta (§5.3).
- The MDE at the actual n for each task row and for the suite gate, and
  the underpowered-gate marker when §7.3 requires it.
- The flake table: every task's §8 classification in both arms, with
  quarantined tasks sectioned separately.
- Budget rows with their declared statistic (median or p95), the n they
  were computed over, and the §9.2 caveat when applicable.
- Identity binding: suite content hash, per-task content hashes, variant
  identities, adapter identity and tier, model identities as
  provider-reported, pricing catalog version (ADR-0009), and harness
  version (FR-RUN-007).
- The wording-contract phrase for the overall verdict and the exit code
  it maps to (§12, §7 of the master CLI surface: 0, 1, 2, 3, 4, 5, 6).

## 14. Explicit deferrals and requirements traced

### 14.1 Deferrals

The following are deferred, recorded in OPEN_QUESTIONS.md with reopen
triggers; the fail-closed default in every case is the fixed-N frequentist
design specified in this document (ADR-0006):

- Bayesian comparison mode. Rejected for 1.0 because prior selection is an
  unauditable knob in a gate that must be contestable in a blocked-PR
  dispute. Reopen trigger: a user population demonstrably needing
  sequential-style cost savings with auditable priors.
- Sequential and group-sequential designs. Rejected because CI re-runs and
  human peeking make error-spending accounting unenforceable across
  retriggered pipelines; a fixed-N design is immune to peeking by
  construction. Reopen trigger: harness-controlled run scheduling that can
  provably own the looks.
- Mixed-effects and hierarchical models (partial pooling of per-task
  rates). Attractive for borrowing strength across tasks; deferred because
  the added model assumptions (random-effect distributions) are exactly
  the kind of contestable structure a 1.0 gate should not hide inside a
  verdict. The stratified bootstrap (§5) captures between-task variance
  without a parametric random-effects assumption. Reopen trigger: evidence
  from accumulated real suites that partial pooling materially improves
  calibrated power.

Until a deferral is reopened and accepted through an ADR, any behavior in
this document remains the only conformant behavior.

### 14.2 Requirements traced

This document is the normative source for the following requirements; the
owning gates and acceptance evidence live in BUILD_PLAN.md:

- FR-STAT-001 — §1.2, §2 (rates over n runs, never single-run booleans).
- FR-STAT-002 — §3.2 (Wilson 95% on every rendered rate).
- FR-STAT-003 — §4.3, §13 (named tests, p/q shown).
- FR-STAT-004 — §6 (BH FDR q = 0.05; raw p and adjusted q reported).
- FR-STAT-005 — §7.3, §12.1 (MDE at actual n in every report).
- FR-STAT-006 — §8 (flake classification).
- FR-STAT-007 — §12 (the wording contract).
- FR-STAT-008 — §10 (self-validation fixtures with injected effects).
- FR-STAT-009 — §5.2 (seeded stratified bootstrap, seed recorded).
- FR-STAT-010 — §1.2, §2.2 (content-hash pairing; drift aborts).
- FR-STAT-011 — §4–§6 applied per matrix cell; one comparison report.
- FR-STAT-012 — §7.2 (published MDE tables computed by the CI code).
- FR-JUDGE-001..010 (partial — the statistical content): §11.1
  (FR-JUDGE-002), §11.2–§11.3 (FR-JUDGE-003, FR-JUDGE-004), §11.4
  (FR-JUDGE-008, FR-JUDGE-009), §11.5 (FR-JUDGE-010), §11.6 summary
  (FR-JUDGE-006, FR-JUDGE-007); rubric mechanics (FR-JUDGE-001), family
  separation (FR-JUDGE-005), and loader rejection (FR-ASSERT-006) are
  normatively owned by ADR-0007, TASK_FORMAT.md, and THREAT_MODEL.md.
- NFR-MAINT-002 — §10.3 (mutation score ≥ 85% on the stats and scoring
  packages).

Nothing in this section, or this document, is implemented today. Each
traced requirement becomes an accepted claim only when its owning gate's
named evidence passes.
