# Assay Landscape and Positioning

Document status: descriptive, not normative. Nothing here fixes an interface,
requirement, or decision; where a sentence appears to, the ADRs and the
normative documents control. Competitive observations are accurate to the
best of the authors' knowledge as of this writing (2026-08-30) and hedged
where the ecosystem moves fast.

Last revised: 2026-08-30.

> Assay is a fully specified, unimplemented evaluation harness. This
> repository currently contains normative planning documents only. No command,
> gate, or measurement described here exists yet.

## 1. Why this document exists

A plan that implies unearned novelty is a failed plan. The agent-evaluation
market is not empty: promptfoo, Braintrust, LangSmith, OpenAI Evals, and
inspect-ai all exist, all overlap with parts of Assay's surface, and several
are years ahead in maturity, adoption, and breadth. Pretending otherwise
would corrupt every downstream decision — scope, sequencing, and marketing
alike — and would eventually be falsified by the first informed reader.

This document therefore does three things:

- names the neighbors honestly, including what each does better than Assay
  plans to;
- states what Assay deliberately does not compete on, so scope pressure has
  a written answer;
- states Assay's narrow defensible claim and shows, tool by tool, which
  pieces of that claim each neighbor already has.

Every Assay capability mentioned below is `planned`. Comparing a plan against
shipped products is inherently asymmetric; the honest reading of every
comparison in this file is "what Assay intends to do differently", never
"what Assay does better today", because today Assay does nothing.

## 2. The neighbors

### 2.1 promptfoo

promptfoo is an open-source LLM evaluation and red-teaming tool built around
declarative YAML test cases, a large library of assertion types
(deterministic matchers, model-graded rubrics, similarity metrics), provider
matrices, and a CLI/CI workflow with a web viewer. It is likely the most
widely adopted way to smoke-test prompts and LLM apps in CI today.

Strengths:

- YAML-first evals with low setup cost; a config file and a command produce
  a comparison matrix across prompts, models, and variables.
- CI-friendly by design: exit codes, GitHub Action, shareable web reports.
- A huge assertion library, including per-response `cost` and `latency`
  assertions and model-graded checks.
- A serious red-teaming product (attack generation, vulnerability scanning)
  that has become a major focus of the project.

Weak for Assay's niche:

- The unit of evaluation is predominantly a single prompt/response pair, or
  a provider call with assertions over its output. Multi-turn agent
  trajectories — tool-call ordering, redundant calls, recovery-versus-loop
  behavior — are not first-class scored objects.
- Pass/fail thresholds exist, but comparison between runs is not framed as a
  statistics problem: there are no confidence intervals, significance tests,
  multiple-comparison control, or stated power behind a red/green outcome.
- Cost and latency assertions are per-response checks, not distribution-level
  budget gates over n runs with reconciliation against provider-reported
  usage.

What Assay takes from it: the conviction that evals belong in CI with exit
codes, and that declarative, diffable test files beat notebooks for review.

### 2.2 Braintrust

Braintrust is a commercial evaluation and observability platform: hosted
datasets, experiment tracking, tracing, human review queues, a playground,
and an agent ("Loop") that helps author and analyze evals. SDKs in
TypeScript and Python integrate evals into application code, and CI
integration posts experiment summaries to pull requests.

Strengths:

- Polished hosted platform: datasets, experiment diffs, score tracking over
  time, and human-in-the-loop review are mature, integrated workflows.
- Strong developer experience for teams that want a shared dashboard and a
  place to accumulate labeled data.
- Real investment in eval authoring assistance and automated analysis.

Tradeoffs relative to Assay's niche:

- Hosted and commercial: the source of truth lives in a SaaS backend.
  Assay's ADR-0002 scope boundary (local-first, no hosted multi-tenant
  backend in 1.0) is the opposite bet, aimed at teams who want eval evidence
  in the repository and no data egress.
- Dashboard-first rather than gate-first: the primary artifact is an
  experiment page a human reads. PR summaries exist, but the product's
  center of gravity is exploration and review, not a blocking status check
  with defined statistical semantics.

What Assay takes from it: experiment diffing as a core workflow, and the
observation that regression review needs a good comparison surface — which
is why Assay plans a local viewer rather than none.

### 2.3 LangSmith

LangSmith is LangChain's observability and evaluation platform: deep tracing
of LLM and agent applications, datasets, offline and online evaluators,
pairwise comparison views, annotation queues, and pytest/Vitest integrations
for running evals in test suites.

Strengths:

- Tracing depth: for applications built on LangChain/LangGraph, every step,
  tool call, and retry is captured with minimal effort, and traces convert
  into eval datasets.
- Mature evaluator tooling, including LLM-as-judge with calibration against
  human annotations, and pairwise (A/B) evaluation views.
- Ecosystem gravity: the default choice inside the large LangChain user
  base, with framework-agnostic SDK paths as well.

Tradeoffs relative to Assay's niche:

- Observability-platform framing: the product organizes around traces,
  projects, and dashboards in a hosted (or self-hosted enterprise) service.
  Gate semantics are something you assemble from its pieces, not the
  product's contract.
- Ecosystem gravity cuts both ways: it is strongest where the application
  already speaks LangChain's abstractions. Assay's subject is any agent
  behind a subprocess adapter, deliberately independent of any framework.
- Statistical treatment of run-to-run variance (fixed-N design, intervals,
  FDR control across tasks) is not the product's language for regressions.

What Assay takes from it: the proof that trajectory-level capture is what
makes agent debugging tractable, and that judge evaluators need calibration
workflows, not vibes.

### 2.4 OpenAI Evals

OpenAI Evals is the open-source framework and registry OpenAI published in
2023 for evaluating models and prompts, with YAML-registered evals, basic
and model-graded eval classes, and a large community registry of examples.
Its lineage matters: it normalized "evals as code" and model-graded
evaluation patterns that most later tools absorbed.

Strengths:

- Registry lineage: a large public corpus of eval definitions and graded
  rubrics that shaped the field's vocabulary.
- Simple, reproducible eval classes for exact-match and choice-based
  grading; early, influential model-graded patterns.

Weak for Assay's niche:

- OpenAI-centric by construction; running against arbitrary local agents or
  non-OpenAI stacks is not the design center. Evaluation of hosted models
  has since largely moved into OpenAI's platform Evals product.
- Maintenance-mode reality: as of this writing the open-source repository
  has seen long periods of minimal activity and community reports of
  bit-rot; it is best treated as historical reference rather than a live
  competitor.
- No agent trajectories, budgets, sandboxing, or statistical gating.

What Assay takes from it: the registry idea — versioned, reviewable eval
definitions — and a caution: an eval framework without an owner and a gate
decays.

### 2.5 inspect-ai (closest neighbor)

Inspect is the open-source evaluation framework from the UK AI Safety
Institute (UK AISI): Python-native, with datasets, solvers (including full
agent loops with tool use), scorers, sandboxed execution environments
(including Docker), extensive model support, a log viewer, and an active
research community. It is used for serious safety and capability
evaluations, including agentic benchmarks.

Strengths — and it is closest, so these deserve plain statement:

- Research maturity Assay does not plan to match: Inspect runs large,
  peer-scrutinized evaluations for a government institute and a broad
  research community. Its breadth of built-in solvers, scorers, benchmarks,
  and model providers is far beyond Assay's planned surface.
- Real agent evaluation: multi-turn solvers, tool use, sandboxed tool
  execution, human agent baselining, and an ecosystem of agentic benchmark
  suites.
- A capable log format and viewer, approval policies for dangerous tool
  calls, and serious engineering throughout.
- The Python ecosystem: for research teams, Python-native scorers and the
  scientific stack are a decisive advantage.

What it does better than Assay plans to, stated plainly: breadth of tasks
and benchmarks, research-grade flexibility, model-provider coverage,
community, and institutional credibility. A team whose primary need is
"evaluate model or agent capability broadly and rigorously in Python" should
likely choose Inspect.

Where it does not cover Assay's niche:

- Inspect is a framework you drive from Python to produce eval logs and
  scores; it is not opinionated about CI gating. Turning its outputs into a
  PR-blocking check with fixed-N statistics, FDR control across tasks, and a
  wording contract is left to the user.
- Budget enforcement exists as limits (time, tokens, messages) that stop a
  sample, which is a different thing from cost budgets as first-class
  pass/fail checks reconciled against provider-reported usage and compared
  across variants.
- Its center of gravity is evaluating models and agents built in or wrapped
  by Python; Assay's subject is an external agent binary behind a
  language-agnostic subprocess contract, with the harness's own CI runnable
  deterministically for $0.

What Assay takes from it: the standard of seriousness. Inspect demonstrates
that sandboxing, tool-aware scoring, and eval logs can be engineered well in
the open, and it sets the bar Assay's much narrower product must meet within
its niche.

## 3. What Assay deliberately does not compete on

Fixed by the ADR-0002 scope boundary, restated here descriptively:

- **Hosted dashboards.** No SaaS, no multi-tenant backend, no cloud storage
  of traces. The viewer is local, loopback-bound, and read-only. Teams that
  want a hosted experiment platform are better served by Braintrust or
  LangSmith, and this document says so.
- **Dataset management and labeling.** Assay consumes task suites from the
  repository; it does not manage datasets, annotation queues, or labeling
  workflows beyond the judge-calibration sets its methodology requires.
- **Prompt playgrounds.** No interactive prompt-iteration surface. Variants
  are files in version control, compared by runs, not by eyeballing.
- **Generic LLM app evals.** Single-response quality checks for chatbots,
  RAG answer grading, and general text metrics are promptfoo's and the
  platforms' home turf. Assay evaluates coding and tool-using agents
  operating on sandboxed workspaces; that specificity is the product.
- **Research benchmark breadth.** Assay ships a harness and a contract, not
  a benchmark library, and does not chase Inspect's coverage.

## 4. The narrow defensible claim

Verbatim, the claim every Assay document is allowed to make and none may
exceed:

> the only harness purpose-built to block a pull request on a statistically
> defended trajectory-quality or cost regression of a coding agent, runnable
> entirely locally against a deterministic synthetic agent for zero dollars.

The claim is a conjunction. Each conjunct exists somewhere in the landscape;
the defensible position is the specific combination, held together by gate
semantics. The checklist:

1. trajectory metrics as first-class assertions;
2. cost/latency budget gates as blocking checks;
3. fixed-N statistical comparison with FDR control;
4. $0 deterministic harness CI (no live provider in any required check);
5. a PR-blocking GitHub Action wired to those semantics.

Honest per-tool assessment of the combination, as of this writing. "Partial"
is explained beneath the table; "planned" marks Assay's unimplemented state.

| Capability | promptfoo | Braintrust | LangSmith | OpenAI Evals | inspect-ai | Assay |
| --- | --- | --- | --- | --- | --- | --- |
| Trajectory metrics as first-class assertions | no | partial | partial | no | partial | planned |
| Budget gates as blocking checks | partial | partial | no | no | partial | planned |
| Fixed-N statistics with FDR control | no | no | no | no | partial | planned |
| $0 deterministic harness CI | partial | no | no | no | partial | planned |
| PR-blocking Action on those semantics | partial | partial | partial | no | no | planned |

Explanations of every `partial`:

- **Braintrust / LangSmith trajectory metrics:** both capture full traces
  and can run evaluators over them, so trajectory-aware scoring is
  achievable; neither ships tool-ordering, redundancy, or
  read-before-write-style metrics as declarative assertions with gate
  semantics.
- **inspect-ai trajectory metrics:** scorers can inspect the full message
  history and tool events, and agentic benchmarks do; the metrics are code
  you write, not a versioned metric set bound to an assertion language.
- **promptfoo budget gates:** per-response `cost` and `latency` assertions
  can fail a test; there is no distribution-level budget (median/p95 over n
  runs) reconciled against provider-reported usage.
- **Braintrust budget gates:** cost and token metrics are tracked per
  experiment and comparable in the UI; blocking a check on a cost
  distribution is user-assembled, not a product contract.
- **inspect-ai budget gates:** time/token/message limits stop runaway
  samples — enforcement, not budget-as-assertion with its own failure
  category and exit code.
- **inspect-ai statistics:** scores report standard errors and the
  community practices rigorous analysis; the framework does not gate on
  Wilson/Newcombe intervals, exact tests, or BH FDR across tasks as a
  built-in verdict.
- **promptfoo deterministic CI:** deterministic providers/mocks are
  achievable and caching helps; the project's own value proposition centers
  on hitting real providers.
- **inspect-ai $0 CI:** `mockllm` and offline runs exist for testing; a
  deterministic synthetic *agent* subject with byte-stable end-to-end
  results as the required gate evidence is not the design center.
- **PR-blocking Actions (promptfoo, Braintrust, LangSmith):** each can fail
  or annotate CI (exit codes, experiment summaries, pytest integration);
  none blocks on a statistically defended trajectory or cost delta, because
  none defines one.

If any cell above is wrong or goes stale — likely, in this ecosystem — the
correction belongs in this file, not in softer wording of the claim
elsewhere. A reader who finds a neighbor shipping the full combination has
found a positioning defect, and this document is where it gets recorded.

## 5. Positioning risks

The combination is defensible, not fortified. Named risks:

- **inspect-ai adds statistical gating.** Most credible risk: Inspect has
  the engineering depth, the community, and adjacent pieces (limits, logs,
  CI usage). A well-designed `inspect gate` command with significance
  testing would collapse conjuncts 3 and partially 2. Mitigation: depth of
  the statistics contract — fixed-N design, wording contract, MDE
  statements, self-validation fixtures with injected effects, mutation-tested
  stats code — plus the subprocess adapter boundary that makes Assay
  language- and framework-agnostic for subjects. Assay must be the tool
  whose red X a team can defend in a dispute, not merely a p-value printer.
- **promptfoo adds trajectory scoring.** promptfoo moves fast and already
  owns the YAML-in-CI mindshare. Mitigation: the trajectory record and
  metrics are Assay's core object, versioned and diffable in a local store
  with a turn-aligned viewer; retrofitting that onto a response-centric data
  model is a large rewrite, and the CI-gate UX (budgets, exit codes,
  idempotent PR comment with intervals) is the product, not a feature.
- **Platforms bundle "good enough" gating.** Braintrust or LangSmith could
  ship PR checks with thresholds and call it regression gating. Mitigation:
  local-first evidence. Assay's comparisons are reproducible from the
  repository and a $0 synthetic subject; a hosted verdict cannot be re-run
  by a skeptical reviewer without an account and spend.
- **The niche is too narrow.** Teams may accept flaky eyeballed evals rather
  than adopt statistical gates. Mitigation: none technical; this is the
  product bet, and the wording contract (no "regression" without its test)
  is what a team buys when a blocked PR must survive an argument.
- **Claim drift.** The subtlest risk is internal: marketing or docs
  overstating the combination as general superiority. Mitigation: every
  public claim maps to an accepted gate's evidence, and this document's
  per-tool table is the reference for what neighbors already do.

ADR-0002 records the scope boundary that this positioning depends on: Assay
is a CI regression gate for agent behavior — not an observability platform,
not a prompt playground, not a dataset labeling tool, not a hosted service.
