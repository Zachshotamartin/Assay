# Assay: Marketing Plan and Launch Assets

**Document status: planned collateral, subordinate to gate evidence.** This
document drafts the public story Assay will tell once the release gates in
[BUILD_PLAN.md](BUILD_PLAN.md) accept. Nothing here is publishable today:

> Assay is under implementation. Gate R0 code and CI evidence exist on an
> open pull request, but R0 is not accepted because required private-repository
> branch protection and review controls are unavailable on the current GitHub
> plan. No later product gate is accepted.

Under conflict rule 11 in [docs/README.md](README.md), this document is
descriptive, not normative, and every claim in it is subordinate to gate
evidence. A marketing claim without an accepted gate behind it is a
documentation defect and is treated exactly like a failing test.

## 1. Marketing Rules of Engagement

These rules bind every asset in this document and every future public
statement about Assay.

- **Every public claim maps to an accepted gate.** Each sentence of public
  copy that asserts capability names, in the claim audit, the gate (R0–R10)
  whose accepted evidence backs it. A claim with no gate, or with a gate
  still planned or in progress, does not ship.
- **The claim audit is a release gate ticket in R10.** Before 1.0
  publication, an R10 ticket walks every public asset sentence-by-sentence
  against the accepted evidence and records the mapping. Soft-launch assets
  get the same audit against R0–R8 evidence before anything is posted.
- **No benchmarketing.** A published number always carries its n, its 95%
  confidence interval, and a link to [METHODOLOGY.md](METHODOLOGY.md). A
  single run is never quoted as a result. Comparison verdicts use only the
  wording contract phrases; "faster", "better", and "smarter" without a
  test behind them are defects.
- **Competitors are named respectfully and accurately.** promptfoo,
  Braintrust, LangSmith, OpenAI Evals, and inspect-ai are real, good tools
  with real strengths. Public copy describes them as
  [LANDSCAPE.md](LANDSCAPE.md) does — honestly — and confines Assay's
  differentiation to the narrow defensible claim. Disparagement, stale
  feature comparisons, and unverifiable "only tool that" claims beyond
  that narrow claim are defects.
- **Status is always current and honest.** Every public asset states what
  is accepted and what is not at the moment of publication, using the
  status vocabulary from [docs/README.md](README.md).

## 2. Positioning Statement

**For** teams shipping coding and tool-using agents, **who** need to know
whether a model, prompt, or toolset change made their agent worse before it
reaches users, **unlike** hosted eval dashboards and observability suites
that report scores for humans to interpret, **Assay is** a local-first CI
gate that scores full agent trajectories, enforces cost and latency budgets
as blocking checks, and refuses to call a difference a regression without a
significance test, confidence intervals, and stated power — runnable
entirely locally against a deterministic synthetic agent for zero dollars.

The positioning rests on the three distinguishing claims, always stated
together and never overstated:

1. Trajectories, not just final answers.
2. Cost and latency budgets that block, not warn.
3. Statistics or silence: no regression verdict without the test behind it.

The narrow defensible claim, verbatim wherever differentiation is asserted:
the only harness purpose-built to block a pull request on a statistically
defended trajectory-quality or cost regression of a coding agent, runnable
entirely locally against a deterministic synthetic agent for zero dollars.

## 3. Audience Segments

### 3.1 Agent developers

- **Pains:** every model or prompt change is a gamble; reruns flip between
  pass and fail; nobody can say whether the agent actually got worse; eval
  bills grow faster than confidence.
- **Message:** stop eyeballing transcripts. Declare the behavior you
  require, run it n times, and let the delta table — with intervals — tell
  you whether the change is real. The deterministic tier costs nothing.

### 3.2 Platform and infrastructure teams

- **Pains:** agents burn budget invisibly; a "quality-neutral" change
  doubles token spend and nobody notices until the invoice; there is no
  gate in CI that owns cost.
- **Message:** budgets that block. Declare a dollar, token, latency, or
  call-count ceiling per task and per suite, and a breach fails the build
  with its own exit code — computed from reconciled provider-reported
  usage, not estimates.

### 3.3 OSS agent maintainers

- **Pains:** contributors propose prompt and toolset changes the
  maintainer cannot evaluate; fork PRs cannot receive provider secrets;
  review is vibes plus a demo GIF.
- **Message:** a GitHub Action that runs the suite against a deterministic
  synthetic subject on fork PRs with zero credentials and zero spend, posts
  one idempotent delta table comment, and blocks on defended regressions.

### 3.4 Eval researchers

- **Pains:** harnesses report single-run scores without uncertainty; LLM
  judges ship uncalibrated; methods are undocumented or unreproducible.
- **Message:** the methodology is the product. Wilson intervals, exact
  tests with FDR control, seeded bootstrap, published power and MDE tables
  computed by the same code CI runs, and judges that may not gate below
  kappa 0.6 against a ≥ 50-item human-labeled calibration set.

## 4. Messaging Pillars

Each pillar derives from a distinguishing claim and carries a proof point
tied to the gate whose acceptance evidence backs it. A pillar may not be
used publicly before its gate accepts.

### 4.1 Statistics or silence

The report emits only the wording contract: regression detected,
improvement detected, no significant difference at the stated MDE, or
insufficient data. Never a verdict without the named test, the intervals,
and the adjusted q value.

- **Proof point (R6):** the statistical self-validation fixtures — a known
  injected regression is detected, and injected pure noise does not fire.

### 4.2 Budgets that block

Cost and latency are first-class pass/fail checks against reconciled
usage summaries across runs, with a distinct exit code and report row. A
change that holds quality constant while materially raising cost fails the
build.

- **Proof point (R5):** a run exceeding a declared token, time, call-count,
  or dollar threshold fails, demonstrated in the R5 acceptance evidence.

### 4.3 Trajectories, not vibes

The full turn-by-turn record is captured losslessly and scored on seven
versioned metrics: tool-selection correctness, ordering sanity,
redundant-call count, read-before-write discipline, error-recovery versus
loop, turns-to-completion, and cost-per-turn.

- **Proof point (R4):** complete trajectories captured and scored against
  trajectory assertions in the R4 acceptance evidence; rendered and diffed
  turn-by-turn once R9 accepts.

### 4.4 Zero-dollar deterministic CI

Required CI spends nothing on providers. The in-repo simulated adapter
produces byte-stable results across runs and platforms, so the harness's
own correctness — and a fork PR's suite run — costs exactly $0.

- **Proof point (R1):** the byte-reproducible simulated-agent suite run in
  the R1 acceptance evidence; zero-credential fork-PR mode lands with R8.

## 5. Launch Assets

Full drafts follow. Every draft is frozen copy pending its claim audit: at
publication time each sentence is re-checked against then-accepted gates,
and any sentence that fails the check is deleted, not softened.

### 5.1 README hero copy (draft)

> **Assay — the CI gate for coding agents.**
>
> Your agent's eval suite should block bad PRs, not decorate a dashboard.
> Assay runs each task n times, scores the full trajectory — every tool
> call, every retry, every dollar — and refuses to call a change a
> regression until a significance test with confidence intervals says so.
> Cost and latency budgets fail the build on breach. The deterministic
> tier runs entirely locally against a synthetic agent for $0.
>
> `assay run`, `assay compare`, and a delta table on your pull request.

Claim mapping: trajectory scoring R4; budgets R5; statistics R6; PR
comment R8; $0 deterministic tier R1.

### 5.2 Comparison one-pager (draft)

Source of truth: [LANDSCAPE.md](LANDSCAPE.md). The one-pager leads with
respect — one honest strength line per tool — then the capability matrix.

Strengths, verbatim from the landscape analysis:

- promptfoo: strong local-first eval and red-teaming CLI with a mature
  assertion library.
- Braintrust: polished hosted eval and observability platform with
  first-class experiment tracking.
- LangSmith: the LangChain ecosystem's hosted tracing and evaluation
  suite, strongest where LangChain is already in use.
- OpenAI Evals: a registry and framework for benchmarking model behavior,
  oriented toward model comparison.
- inspect-ai: rigorous open-source research eval framework with real
  trajectory and tool-use support, oriented toward safety evaluations.

Capability matrix (draft; every cell re-verified against each tool's
current documentation during the claim audit before publication):

| Capability | Assay | promptfoo | Braintrust | LangSmith | OpenAI Evals | inspect-ai |
| --- | --- | --- | --- | --- | --- | --- |
| Trajectory-level scoring metrics | Core | Partial | Partial | Partial | No | Yes |
| Blocking cost/latency budget gates | Core | No | No | No | No | No |
| CIs + significance tests on every delta | Core | No | No | No | No | Partial |
| Judge assertions gated on calibration kappa | Core | No | No | No | No | No |
| $0 deterministic offline CI mode | Core | Partial | No | No | No | Partial |
| Local-first, no hosted backend required | Yes | Yes | No | No | Yes | Yes |
| PR status check + idempotent delta comment | Core | Partial | Partial | Partial | No | No |

Footer, mandatory on the one-pager: "Assay column reflects gates accepted
at publication date; n, intervals, and methodology at the linked
METHODOLOGY.md. Competitor cells cite each tool's own docs."

### 5.3 Demo storyboard: a PR blocked by a cost regression (GIF script)

Total runtime about 30 seconds, looping. Terminal and GitHub UI only, no
narration, captions burned in. Recorded only from a real run once R8
accepts; no staged output.

1. **Scene 1 (0–3 s).** A GitHub PR titled "Switch planner prompt to v2".
   Caption: "A prompt change. Looks harmless."
2. **Scene 2 (3–7 s).** The Assay Action check starts. Terminal pane shows
   `assay run suites/coding-core.yaml --variant candidate -n 10`.
   Caption: "Assay runs every task 10 times."
3. **Scene 3 (7–13 s).** `assay compare baseline candidate` prints the
   delta table: pass-rate column unchanged, all quality verdicts "no
   significant difference at stated MDE". Caption: "Quality: unchanged."
4. **Scene 4 (13–19 s).** The cost row highlights: median cost per task
   up from $0.021 to $0.049 against a $0.030 suite budget; the budget row
   reads breach. Caption: "Cost: more than doubled."
5. **Scene 5 (19–24 s).** Exit code 2. The GitHub status check flips to
   red: "assay: budget breach — median cost/task $0.049 > $0.030".
   Caption: "The build fails. Not a warning. A wall."
6. **Scene 6 (24–28 s).** The PR comment: one idempotently-updated delta
   table with intervals and the budget row. Caption: "The evidence is on
   the PR."
7. **Scene 7 (28–30 s).** Closing card: "Assay — statistics or silence.
   github.com/[org]/assay" (final URL inserted at publication).

Claim mapping: scenes 2–3 R6, scene 4–5 R5, scene 6 R8.

### 5.4 Show HN / launch post (draft, soft-launch edition)

Published only after R8 accepts and only after every line passes the claim
audit against then-accepted evidence. Draft:

> **Show HN: Assay — a CI gate that blocks agent PRs on statistically
> defended regressions**
>
> I build coding agents, and my eval loop was: run the suite once, stare
> at a dashboard, and argue about whether 71% versus 68% means anything.
> It usually doesn't — at n = 1 it never does. So I built the harness I
> wanted and I'm sharing it early.
>
> Assay treats agent evals as a CI gate, not a dashboard. Three things
> make it different:
>
> 1. It scores trajectories, not just final answers: tool-selection
>    correctness, redundant calls, read-before-write discipline,
>    error-recovery versus loops, turns, and cost per turn.
> 2. Budgets block. Token, latency, call-count, and dollar ceilings are
>    pass/fail checks with their own exit code, computed from reconciled
>    provider-reported usage across n runs — not a single lucky run.
> 3. It refuses to say "regression" without statistics. Pass rates carry
>    Wilson intervals; deltas get an exact test with FDR control; the
>    report states the minimum detectable effect for your n; and the only
>    verdicts it can emit are "regression detected", "improvement
>    detected", "no significant difference at the stated MDE", or
>    "insufficient data".
>
> Everything runs locally. Your traces stay in a SQLite store on your
> machine; the only network egress is the provider calls you configure.
> Required CI is deterministic and spends $0: an in-repo scripted agent
> produces byte-identical results, so fork PRs run with zero credentials.
>
> Honest status: Assay is young. Gates R0 through R8 are accepted with
> published evidence — the runner, sandbox, trajectory scoring, budget
> gates, statistical comparison, judge calibration, and the GitHub Action
> are real and tested. The trace viewer (R9) and 1.0 packaging (R10) are
> not done, and the docs mark every planned item as planned.
>
> The methodology doc explains every test, constant, and wording rule,
> and I'd genuinely value review from people who do statistics for a
> living. The landscape doc names promptfoo, Braintrust, LangSmith,
> OpenAI Evals, and inspect-ai and what they're each better at — this
> tool has exactly one narrow claim and I've tried not to exceed it.

### 5.5 Conference talk abstract (draft)

> **Blocking the PR: agent evals as a statistics problem**
>
> Your coding agent's eval suite says 71% this week and 68% last week.
> Did it get worse? At n = 1, nobody knows — and most harnesses ship that
> non-answer to a dashboard. This talk treats agent evaluation as a CI
> gating problem: scoring full trajectories instead of final answers,
> enforcing cost and latency budgets as blocking checks, and applying
> honest small-sample statistics — Wilson intervals, exact tests with
> false-discovery control, seeded bootstrap, and reported minimum
> detectable effects — so a build fails only on a defensible regression.
> We walk through a real PR blocked on a cost regression at unchanged
> quality, the calibration bar an LLM judge must clear before it may
> gate anything, and the design rule behind it all: if the harness cannot
> defend the verdict, it must say nothing. Built in the open as Assay;
> every number shown carries its n and interval.

## 6. Channel Plan

Channels in sequence; each step gates on the prior one holding up (no
critical defect reports, claim audit still accurate).

1. **GitHub.** The repository is the primary asset: honest README, the
   doc set, and published gate evidence. Everything else links here.
   Continuous from soft launch.
2. **Show HN.** The §5.4 post, submitted once, timed mid-week morning US
   Eastern, with the author present in the thread all day answering
   honestly, including about what is not built.
3. **X and Bluesky dev community.** A short thread per messaging pillar
   (four total, one per week after soft launch), each ending on the demo
   GIF or a delta-table screenshot with n and intervals visible.
4. **Evals newsletters and podcasts.** Direct pitches to AI-engineering
   newsletters and eval-focused podcasts with the one-pager and the
   methodology doc; the pitch offers the statistics angle, not a product
   tour.
5. **Direct outreach to agent-framework maintainers.** Personal notes to
   maintainers of open-source coding agents and agent frameworks offering
   an adapter conversation, referencing the `assay-adapter/1` contract
   doc and the zero-credential fork-PR mode built for their contributors.

## 7. Launch Sequencing Tied to Gates

Marketing motion is gated exactly like code. BUILD_PLAN R10 owns the
marketing tickets: asset production, the claim audit against accepted
evidence, and publication.

- **Before R8 acceptance: nothing public.** No posts, no submissions, no
  outreach. The repository may be public for contributors, but no asset in
  §5 is published and no channel in §6 is activated.
- **Soft launch: after R8 evidence is accepted.** Publishable: the README
  hero, the Show HN post (§5.4, soft-launch edition), the demo GIF, and
  the pillar threads — each audited against R0–R8 evidence first. The
  post's status paragraph states plainly that R9 and R10 are open.
- **Public 1.0 launch: only after R10 accepts**, which includes the
  published public result set — a real suite, a real comparison, full
  methodology, n, and intervals, reproducible from the repository. The
  one-pager and conference submissions ship at 1.0, after the R10 claim
  audit.

### Claim-audit checklist (run per asset, per publication)

1. List every sentence that asserts a capability, number, or guarantee.
2. Map each to the gate (R0–R10) whose accepted evidence backs it; link
   the evidence artifact.
3. Delete any sentence whose gate is not accepted; do not soften it.
4. Verify every number carries n and a 95% interval and links to
   [METHODOLOGY.md](METHODOLOGY.md).
5. Verify verdict language uses only the wording contract phrases.
6. Verify competitor statements against each tool's current public
   documentation; update or delete stale cells in the §5.2 matrix.
7. Verify the asset's status paragraph matches the gate table on the day
   of publication.
8. Record the completed audit in the R10 (or soft-launch) ticket with
   reviewer sign-off.

## 8. Deferrals and Traceability

Deferred inline, deliberately not added to OPEN_QUESTIONS.md because they
require no design decision, only future budget and taste:

- **Paid marketing** (sponsorships, ads, paid newsletter placement) is
  deferred until after the 1.0 launch has run its organic course; it would
  add spend, not credibility, before then.
- **Logo and brand system** are deferred; through 1.0 the brand is the
  delta table, the wordmark is plain text "Assay", and asset design stays
  minimal and consistent by convention.

Traceability: this document supports R10 acceptance evidence — the
marketing tickets in BUILD_PLAN R10 produce, audit, and publish the assets
drafted here — and it is governed by conflict rule 11 in
[docs/README.md](README.md): descriptive, not normative, with every claim
subordinate to gate evidence. A marketing claim without an accepted gate
behind it is a documentation defect.

Last revised: 2026-08-30.
