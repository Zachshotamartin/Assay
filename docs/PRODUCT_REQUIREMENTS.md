# Assay: Product Requirements and User Flows

Document status: normative product specification for the Assay evaluation
harness. Last revised: 2026-08-30.

Implementation status: R0 and R1 have code and local evidence on gate branches,
but neither is accepted. The only branch-local R1 command evidence is for the
source-built `validate` and `run` paths against the deterministic simulated
adapter, with no isolation and no real agent or provider support.

The requirements below remain normative targets. A capability becomes
claimable only when its owning release gate in
[BUILD_PLAN.md](./BUILD_PLAN.md) names passing evidence. Statistical
definitions and result wording are controlled by
[METHODOLOGY.md](./METHODOLOGY.md); component boundaries by
[ARCHITECTURE.md](./ARCHITECTURE.md); the task schema by
[TASK_FORMAT.md](./TASK_FORMAT.md); adapter conformance by
[AGENT_COMPATIBILITY.md](./AGENT_COMPATIBILITY.md); security and privacy
evidence by [THREAT_MODEL.md](./THREAT_MODEL.md) and
[PRIVACY_AND_DATA.md](./PRIVACY_AND_DATA.md); competitive description by
[LANDSCAPE.md](./LANDSCAPE.md); and public messaging by
[MARKETING.md](./MARKETING.md), whose claims are subordinate to gate evidence.

## 1. Product Definition

Assay is an evaluation harness for coding and tool-using agents that treats
evals as a CI gate rather than a dashboard. A developer describes agent tasks
in reviewable YAML, runs them repeatedly against an agent through a versioned
adapter contract, and receives verdicts that are statistically defended: pass
rates with confidence intervals, budget checks that block on cost and latency,
and comparisons that refuse to call a difference a regression without a
significance test.

Assay makes three distinguishing claims, always stated together and never
overstated:

1. It scores **trajectories** — the full turn-by-turn record of model requests,
   tool calls, and timings — not just final answers.
2. It enforces **cost and latency budgets** as blocking pass/fail checks.
3. It treats **stochastic comparison as a statistics problem**: it refuses to
   call a difference a regression without a significance test, confidence
   intervals, and stated power.

The market is not empty. promptfoo, Braintrust, LangSmith, OpenAI Evals, and
inspect-ai exist and are described honestly in
[LANDSCAPE.md](./LANDSCAPE.md). Assay's narrow defensible claim is that it is
the only harness purpose-built to block a pull request on a statistically
defended trajectory-quality or cost regression of a coding agent, runnable
entirely locally against a deterministic synthetic agent for zero dollars.
Assay never implies novelty beyond that claim.

Assay is a CI regression gate for agent behavior. It is not an observability
platform, not a prompt playground, not a dataset labeling tool, and not a
hosted service. Anything requiring a hosted multi-tenant backend is out of
scope for 1.0 (ADR-0002).

### 1.1 One-sentence pitch

Assay is the evaluation harness that blocks a pull request when a coding
agent's trajectories get worse or more expensive, and defends that verdict
with a significance test — runnable entirely locally, for zero dollars,
before any API key is involved.

### 1.2 Flagship demonstration

The portfolio demonstration is a pull request blocked by a statistically
defended trajectory and cost regression, produced fully locally and for zero
dollars using the in-repo simulated agent:

1. A repository contains an Assay suite of coding tasks and a GitHub Action
   configured with a baseline branch.
2. A developer opens a pull request that changes the agent's prompt in a way
   that makes it retry a failing tool call in a loop and roughly doubles
   token spend on several tasks.
3. CI runs `assay run` for the baseline variant and the candidate variant
   against the deterministic simulated agent, ten runs per task per variant,
   with recorded seeds. No provider credential exists in the workflow and no
   dollar is spent.
4. `assay compare` pairs runs by identical task content hashes, computes
   per-task deltas with Newcombe hybrid score intervals and a two-sided
   Boschloo exact test, applies Benjamini-Hochberg FDR control at q = 0.05,
   and computes the suite-level delta with a seeded stratified
   paired-by-task bootstrap.
5. The Action posts one idempotently-updated PR comment containing the delta
   table with confidence intervals, the named tests, raw and adjusted
   p-values, the minimum detectable effect at the n used, and the budget
   verdicts showing the cost breach.
6. The blocking status check fails with exit code 3 (`regression detected`)
   and exit code 2 semantics recorded for the budget breach; the PR cannot
   merge.
7. The developer runs `assay view` locally, opens the two runs of a
   regressed task side by side, and the diff view marks the first divergent
   turn — the point where the candidate begins repeating an identical tool
   call.
8. The developer fixes the prompt, pushes, and the same pipeline reports
   `no significant difference at stated MDE` with the budget gates green;
   the check passes with exit code 0.

Everything in this demonstration is deterministic, byte-reproducible, local,
and free. The same harness must also support bring-your-own-key real
provider runs with reconciled usage accounting, but never as the mechanism
that proves harness logic.

### 1.3 Product hierarchy

When priorities conflict, the product is ordered as follows:

1. statistically defended comparison verdicts that can block a merge;
2. deterministic, zero-dollar local operation against the simulated agent;
3. faithful, lossless, redacted trajectory capture and scoring;
4. budget enforcement on reconciled cost, tokens, time, and call counts;
5. honestly bounded sandbox isolation with named escape-test evidence;
6. accurate real-provider execution and usage reconciliation;
7. calibrated judge assertions with reported human agreement;
8. trace viewing, diffing, and export ergonomics.

Work that does not unlock or protect one of these does not precede them.

## 2. Primary Users and Jobs

### 2.1 Agent developer

The primary user builds a coding or tool-using agent — a CLI agent, an IDE
agent, or an internal automation — and changes prompts, toolsets, and models
weekly. They want to know, before merging, whether a change made the agent
worse, slower, or more expensive.

Required jobs:

- author a task as a reviewable YAML file with fixtures and assertions;
- run a suite locally against a simulated agent with zero setup and zero
  spend;
- run the same suite against their real agent through an adapter;
- compare two variants and get a verdict they can defend in review;
- see why a task regressed by diffing two trajectories turn by turn;
- declare budgets so a cost regression fails the build even when quality
  holds.

### 2.2 Platform and infrastructure team evaluating agents in CI

This user owns the CI pipeline for one or more agent products. They need a
GitHub Action with pinned versions, least-privilege permissions, secrets that
never leak into logs, an idempotent PR comment, a configurable blocking
threshold, explicit baseline selection, and a zero-credential mode for fork
pull requests. They need exit codes stable enough to script against and
failure categories stable enough to alert on.

### 2.3 Open-source agent maintainer

This user maintains a public agent repository and cannot put provider
credentials in front of untrusted fork PRs. They need the simulated and
synthetic subjects to carry the required CI signal for free, deterministic
suite results that contributors can reproduce byte-identically, and reports
that distinguish task failure from infrastructure error so flaky
infrastructure never poisons contributor trust.

### 2.4 Research engineer

This user studies agent behavior: tool-selection correctness, loop detection,
error recovery, cost-per-turn curves across models. They need versioned
trajectory metrics, a variant matrix across models and prompt versions,
exportable redacted run bundles, published power/MDE tables computed by the
same code CI uses, and a methodology document precise enough to cite.

### 2.5 Portfolio reviewer

This user needs to see that Assay contains real systems work rather than a
thin wrapper: a subprocess adapter protocol, OCI sandbox orchestration with
guaranteed cleanup, capture-boundary secret redaction, a SQLite-plus-blob
trace store, implemented interval and exact-test statistics with mutation
testing, judge calibration with red-team evidence, and a CI integration
proven against a real test pull request.

## 3. Product Principles

### 3.1 Trajectories over answers

The unit of evaluation is the full trajectory: every model request and
response, every tool call with arguments and result, timings, token counts,
and cost. Final-answer scoring alone is the degraded black-box tier, and
every report produced in that tier states its measurement limits.

### 3.2 Budgets are gates

Token, wall-clock, tool-call, and dollar budgets are blocking pass/fail
checks with their own exit code, not advisory annotations. A change that
holds quality constant while materially raising cost fails the build.

### 3.3 Statistics or silence

Assay never calls a difference a regression without a significance test,
confidence intervals, and stated power. Every comparing surface emits only
the permitted wording-contract phrases defined in
[METHODOLOGY.md](./METHODOLOGY.md). Where the data cannot support a claim,
the only honest output is `insufficient data`.

### 3.4 Deterministic and free harness CI

Every required harness CI check runs with zero live provider calls and zero
dollars. Harness logic is proven by the deterministic simulated adapter;
recorded fixtures cover real-provider code paths. A paid call never proves
what a synthetic one can prove.

### 3.5 Local by default

Runs, trajectories, comparisons, and the viewer live in a local store under
the project. The only network egress is an explicit provider call the user
configured, or a task-declared sandbox allowlist that visibly downgrades the
run's isolation label. There is no telemetry in 1.0.

### 3.6 Honest landscape positioning

Competitors are named and described accurately in
[LANDSCAPE.md](./LANDSCAPE.md). Assay claims exactly one narrow defensible
position and nothing broader. A marketing claim without an accepted gate
behind it is a documentation defect.

### 3.7 Judge results never stand without calibration

An LLM-as-judge verdict is invalid without a checked-in rubric, a
calibration set of at least 50 human-labeled items, and reported
judge-to-human agreement. A judge with Cohen's kappa below 0.6 may not gate;
it reports advisory-only. Agreement metadata travels with the verdict to
every surface that shows it.

### 3.8 Sandbox claims bounded by named evidence

Sandbox isolation claims are stated with their boundary: OCI containers
share a kernel with the host through the container runtime, and a
compromised kernel or Docker daemon is outside the defended boundary. Every
isolation claim maps to named escape tests in
[THREAT_MODEL.md](./THREAT_MODEL.md). Unavailable sandboxing is a hard,
actionable error, never a silent downgrade to host execution.

### 3.9 Layered assertions, cheapest first

Assertions evaluate in layers: deterministic checks, then programmatic
checkers, then judges. Cheaper layers cannot be reordered after judges. A
suite that can fail on an exit code never spends a judge token to find out.

### 3.10 Append-only history

Runs append; they never mutate or overwrite prior records. Reruns create new
run records bound to content hashes, seeds, and versions. Metric definition
changes bump metric versions and old runs keep old values. History that can
be rewritten is not evidence.

## 4. Scope

### 4.1 Required for the first usable release

The first usable release is one cumulative bundle produced only after the R8
gate in [BUILD_PLAN.md](./BUILD_PLAN.md) is accepted, with every earlier gate
(R0 through R7) accepted beneath it. It requires:

- declarative YAML task and suite files validated by published JSON Schemas,
  with `extends` inheritance and `matrix` parameterization;
- `assay validate` for tasks, suites, checkers, and rubrics without running
  anything;
- `assay run` executing a suite for one variant with a declared runs-per-task
  count, a fixed run state machine, stable exit codes, and append-only
  persistence in the local trace store;
- the in-repo deterministic simulated adapter and byte-reproducible
  simulated-agent results;
- the versioned `assay-adapter/1` JSONL subprocess contract with conformance
  tiers and the Robin reference adapter at pinned-preview tier;
- sandboxed execution in dedicated OCI containers with content-addressed
  fixture materialization, default-deny networking, resource limits,
  guaranteed cleanup via `assay gc`, and CI escape-attempt tests;
- bring-your-own-key real-provider execution with provider-reported usage as
  the source of truth, independent estimation from a versioned pricing
  catalog, and fail-closed reconciliation;
- complete trajectory capture with canonical serialization, versioned
  trajectory metrics, and trajectory assertions;
- budget gates on tokens, wall-clock time, tool-call count, and dollars,
  evaluated against statistical summaries across runs, plus the
  runaway-suite spend guard and `--dry-run` spend ceilings;
- the full statistical comparison pipeline: Wilson intervals, Newcombe
  deltas, Boschloo exact tests with the Fisher fallback, BH FDR control,
  seeded stratified bootstrap for suite deltas, MDE reporting, flake
  classification, and the wording contract;
- judge assertions with rubric files, calibration sets, agreement reporting,
  the kappa gate, cross-family defaults, isolation transforms, k-vote
  majority, and the passing red-team manipulation suite;
- the GitHub Action with pinned versioning, idempotent PR comment, blocking
  status check, least-privilege permissions, explicit baseline selection,
  fork-PR zero-credential mode, and real-test-PR integration evidence;
- capture-boundary secret redaction on every persisted record, verified by
  the planted-credential corpus.

### 4.2 Required for Assay 1.0

Assay 1.0 is claimable only after the R10 gate is accepted, which requires
R9 beneath it:

- every first-usable-release capability above remains green;
- the local read-only viewer: `assay view`, full trajectory rendering,
  two-run diff with first-divergent-turn location, loopback binding with a
  per-session token, and the 200-turn render performance target;
- explicit forward-only store migrations tested against old-version fixture
  databases, and task-format migration tooling with old-version fixtures;
- `assay export` self-contained redacted bundles and `assay delete` scoped
  removal, with retention policy defaulting to keep-everything-local per
  [PRIVACY_AND_DATA.md](./PRIVACY_AND_DATA.md);
- packaging, install, and documentation completeness per
  [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md), including the
  provenance-published GitHub Action;
- every public contract (task format, adapter contract, event union, store
  schema, Action inputs) versioned;
- a published public result set satisfying the 1.0 gate;
- the marketing claim audit: every public claim in
  [MARKETING.md](./MARKETING.md) maps to an accepted gate's evidence.

### 4.3 Explicit non-goals

- a hosted service or any hosted multi-tenant backend (ADR-0002);
- an observability platform: Assay records evidence for verdicts, not a
  general telemetry or tracing product for production agents;
- a prompt playground: Assay compares declared variants, it is not an
  interactive prompt-iteration UI;
- a dataset labeling tool: calibration labels are authored outside Assay
  and referenced with provenance, not produced by an Assay labeling UI;
- training or fine-tuning loops: Assay evaluates agents, it does not
  optimize model weights or generate training data pipelines;
- non-coding chat evaluations as a primary target: generic chatbot quality
  scoring is out of scope; the product surface is coding and tool-using
  agent behavior;
- claiming that an arbitrary agent binary is automatically evaluable
  without an adapter (see section 11).

## 5. CLI and Configuration Surface

The executable is `assay`. Exact flag spellings are versioned with CLI
snapshots before 1.0. The required command surface is:

| Invocation | Required behavior |
| --- | --- |
| `assay init` | Scaffold a project: config file, example task and suite, store directory; never overwrites existing files without confirmation. |
| `assay validate [paths]` | Validate tasks, suites, checkers, and rubrics against published schemas without running anything; exit 4 on any invalid input. |
| `assay run <suite> --variant <name> [-n N] [--adapter X] [--seed S] [--dry-run] [--unsafe-host-exec]` | Execute the suite for one variant with N runs per task (default 10); `--dry-run` prints the resolved plan and spend ceiling with no side effects; `--unsafe-host-exec` is the only path to host execution and banners every report. |
| `assay compare <baseline> <candidate> [--threshold T]` | Compare two stored suite results under the ADR-0006 statistical method; exit 3 on `regression detected` at the configured threshold. |
| `assay report <run> [--format md\|json]` | Render a stored run or comparison as Markdown or JSON under the wording contract. |
| `assay matrix <matrix.yaml>` | Run suites across a declared variant matrix (models, prompt versions, toolset versions, agent versions) and produce one comparison report. |
| `assay judge calibrate <rubric>` | Run a judge over the rubric's calibration set and store percent agreement and Cohen's kappa per rubric version and judge model. |
| `assay view [--port P]` | Start the local-only, loopback-bound, token-authenticated read-only viewer over the trace store. |
| `assay gc` | Reap labeled sandbox containers and volumes; also runs on start, on exit, and on signal. |
| `assay db migrate` | Apply forward-only store migrations explicitly; migration never happens implicitly on read. |
| `assay export <run...>` | Produce a self-contained redacted bundle of the selected runs. |
| `assay delete <run...>` | Remove exactly the selected runs and their blobs, with a dry-run inventory. |
| `assay doctor` | Read-only diagnostics: toolchain, Docker socket, store health, config validity, adapter availability. |
| `assay redact-check <file>` | Run the redaction ruleset and entropy scanner against a file and report findings without persisting anything. |

No command sends data to a provider unless the resolved configuration names a
provider and the command's semantics require one. `assay validate`,
`assay report`, `assay view`, `assay gc`, `assay db migrate`, `assay export`,
`assay delete`, `assay doctor`, and `assay redact-check` never contact a
provider.

### 5.1 Exit codes

Exit codes are stable, documented, and scriptable:

| Code | Meaning |
| --- | --- |
| 0 | Success; for comparisons, no regression at the configured threshold. |
| 1 | One or more task failures (assertions failed; harness healthy). |
| 2 | Budget breach (a declared budget gate failed). |
| 3 | Regression detected by a statistical comparison. |
| 4 | Invalid input or configuration (schema, flags, unknown keys). |
| 5 | Infrastructure error (sandbox, adapter, provider, storage). |
| 6 | Cancelled (SIGINT/SIGTERM handled; terminal state persisted). |

When multiple conditions occur in one invocation, the highest-severity
applicable code among 5, 4, 3, 2, 1 is returned, except that cancellation
(6) always reports 6. Every nonzero exit is accompanied by a stable error
category from the taxonomy in section 8.

### 5.2 Configuration precedence and startup validation

Configuration resolves in strict precedence order:

1. CLI flags;
2. environment variables prefixed `ASSAY_`;
3. the project file `assay.config.yaml`;
4. built-in defaults.

Startup validation parses the merged configuration against a published
schema and rejects unknown keys with `invalid_configuration` and exit code
4 before any run, sandbox, or provider activity. Secrets never appear in
`assay.config.yaml`; credential references resolve at spawn time from the
environment or OS keychain and are never persisted by Assay.

## 6. Core User Flows

### 6.1 Authoring a task

1. The author creates a YAML task file declaring `format_version`, a stable
   unique `id`, `title`, `tags`, a `fixture` reference (a content-addressed
   archive or an in-repo directory), the `prompt`, the `toolset`, the
   `sandbox` specification with pinned image digest, ordered `assertions`,
   optional `budgets`, and an optional `runPolicy`.
2. Deterministic assertions are declared first: `exit_code`, `tests_pass`,
   `file_exists`, `file_contains`, `file_absent`, `json_schema`,
   `diff_matches`, or `command_output`.
3. Where deterministic checks are insufficient, the author references a
   TypeScript checker module exporting a typed `check` function; the module
   path is declared in the task and executed later in a restricted worker.
4. A judge assertion may be declared only with a rubric file reference and a
   calibration reference; without both, the loader rejects the task.
5. The task declares its network policy and credential requirements
   explicitly; the default is no network and no credentials.
6. Shared structure moves into a parent task via `extends` single-parent
   inheritance; variants across inputs use `matrix` parameterization, which
   expands to concrete task instances with deterministic ids at load time.
7. The author commits the task; because tasks are plain-text and declarative
   with no execution at parse time, reviewers can diff the exact change in
   the pull request.

### 6.2 Validating a suite

1. The author creates a suite file selecting tasks by path and tag; task
   ordering is deterministic.
2. `assay validate` loads every referenced task, suite, checker, and rubric.
3. Validation checks JSON Schema conformance, unknown-field rejection,
   `format_version` compatibility, `extends` cycle rejection, matrix
   expansion, id uniqueness and filesystem/DB safety, fixture reference
   resolvability without any network fetch, checker module loadability and
   export shape, and judge rubric and calibration references.
4. Every finding names the file, path, field, and violated rule; findings
   are reported together rather than stopping at the first.
5. Exit code 0 means the suite is runnable as declared; exit code 4 with
   `task_invalid`, `suite_invalid`, or `checker_invalid` means it is not.
   Nothing is executed in either case.

### 6.3 First local run against the simulated agent

1. In a fresh project, the user runs `assay init`, then
   `assay run suites/example.yaml --variant baseline --adapter simulated`.
2. No Docker daemon, credential, or network connection is required for the
   simulated adapter's non-sandboxed example suite; the run costs zero
   dollars and reports `source: synthetic` usage.
3. The harness resolves configuration, validates the suite, records the
   run plan (suite content hash, task hashes, variant, adapter identity,
   seeds, harness version), and executes each task through the run state
   machine.
4. The simulated adapter deterministically emits scripted text, tool calls,
   errors, and loops per its fixture script.
5. Assertions evaluate layer by layer; results, trajectories, and metrics
   persist append-only to `.assay/assay.db` and the blob store.
6. `assay report <run>` renders per-task outcomes as pass rates over n runs
   with Wilson intervals, never single-run booleans in any comparing
   surface.
7. Re-running the identical command with the same seed produces
   byte-identical scored results; this reproducibility is release-gate
   evidence, not best effort.

### 6.4 Sandboxed run

1. A task declares a sandbox image pinned by digest; the user runs the
   suite normally.
2. The harness verifies the fixture archive hash, starts a dedicated
   container per task run with `--network none`, read-only root filesystem,
   tmpfs scratch, CPU/memory/pids limits, and no ambient credentials, and
   materializes the fixture via tar stream into a container-private
   workdir volume. The container never sees the harness checkout.
3. If a task declared a network allowlist, the run proceeds with the
   isolation label visibly downgraded in every report.
4. The agent subprocess runs inside the sandbox under the task's isolation
   policy, bounded by harness-side monotonic wall-clock timeouts and hard
   kill limits.
5. After agent exit, the harness takes a content-addressed workspace
   snapshot from the container; assertions evaluate hermetically against
   that snapshot and cannot see harness host state.
6. Labeled containers and volumes are removed on completion; on crash or
   signal, the reaper removes them on the next start via `assay gc`.
7. If no Docker socket is available, the run fails with
   `sandbox_unavailable`, a stable and actionable error; it never silently
   degrades to host execution. Host execution exists only behind
   `--unsafe-host-exec` and banners every resulting report.

### 6.5 BYOK real-provider run

1. The user configures a provider credential reference (environment
   variable or OS keychain reference) and a variant naming a real model.
2. At spawn time the credential resolves and reaches the provider client;
   Assay never persists it, never places it in argv, and redacts it from
   every log, trace, report, and bundle.
3. The adapter reports model identity, token usage, and cost per model
   request; the harness independently derives an estimate from the
   versioned pricing catalog.
4. Reconciliation runs per model request and per run: relative token
   discrepancy above 1% or dollar discrepancy above $0.01 marks the run
   `usage_unreconciled`, which fails budget gates closed.
5. Before execution, `--dry-run` prints the resolved plan with the
   estimated spend ceiling; during execution the runaway-suite guard
   aborts if projected spend exceeds the declared suite dollar ceiling.
6. Reports separate provider latency, tool latency, and harness overhead,
   and label usage by source. Real-provider runs are never required CI
   evidence; required CI stays at zero provider spend.

### 6.6 Comparing two variants

1. The user runs the suite for a baseline variant and a candidate variant,
   each with the declared n (default 10, minimum 5 for any comparative
   claim stronger than `insufficient data`).
2. `assay compare <baseline> <candidate>` verifies that the two results
   pair runs with identical task content hashes; any drift aborts with
   `comparison_invalid` rather than comparing unlike tasks.
3. Per task, the comparison computes pass-rate deltas with Newcombe hybrid
   score intervals and a two-sided Boschloo exact test (Fisher exact as
   the documented fallback), then applies Benjamini-Hochberg FDR control
   at q = 0.05 across the per-task tests.
4. The suite-level delta uses a stratified paired-by-task bootstrap (BCa,
   10,000 resamples) with a recorded seed.
5. The report names every test, shows raw and adjusted p-values, states
   the minimum detectable effect for the actual n used, and classifies
   each task as always-pass, always-fail, or unstable.
6. The exit code is 3 only when the wording contract's `regression
   detected` verdict applies at the configured threshold; otherwise 0.

### 6.7 Reading a delta table

1. Every delta table row shows: task id, baseline rate with 95% Wilson
   interval, candidate rate with 95% Wilson interval, the delta with its
   Newcombe interval, the named test, raw p, BH-adjusted q, and the flake
   class.
2. The suite summary row shows the bootstrap suite delta, its BCa
   interval, the recorded bootstrap seed, and the minimum detectable
   effect at the n used.
3. The verdict column emits only the permitted wording-contract phrases:
   `regression detected`, `improvement detected`, `no significant
   difference at stated MDE`, and `insufficient data`. No surface ever
   prints "worse", "better", "probably", or any phrase outside the
   contract.
4. `no significant difference at stated MDE` is always accompanied by the
   MDE value, so a non-detection is never read as proof of equivalence.
5. Budget rows are distinct from assertion rows and show the declared
   threshold, the statistical summary compared (median or p95 as
   declared), and the reconciliation status.
6. Any judged result in the table carries its agreement metadata (percent
   agreement and kappa) inline; a same-family judge override is flagged on
   every row it affects.

### 6.8 Judge calibration flow

1. The author writes a rubric file and checks it into the suite alongside
   a calibration set of at least 50 human-labeled trajectory excerpts with
   documented labeling provenance.
2. `assay judge calibrate <rubric>` runs the configured judge model over
   the calibration set, using the documented isolation transform:
   subject output enters judge prompts only inside delimited,
   provenance-labeled, instruction-stripped blocks.
3. Percent agreement and Cohen's kappa are computed and stored per rubric
   version and judge model.
4. If kappa is at least 0.6, judge assertions referencing this rubric may
   gate; below 0.6 they run advisory-only and every report says so.
5. The judge model must differ in family from the subject model; a suite
   may set `allow_same_family_judge: true`, and every report including a
   judged result then flags it.
6. Judge non-determinism is handled by k = 3 vote majority with the vote
   distribution stored. Judge calls are cost-accounted and budget-gated
   like any provider call.
7. Editing the rubric invalidates the stored agreement; rubric and
   calibration version together and calibration must be re-run before the
   judge may gate again.

### 6.9 CI and GitHub Action flow

1. The repository pins the Assay GitHub Action by version and configures
   the suite path, variants, baseline selection (branch, tag, or stored
   run id — always explicit), and the blocking threshold.
2. On a pull request, the Action runs `assay run` for baseline and
   candidate and `assay compare` between them.
3. The Action posts one PR comment containing the delta table with
   confidence intervals; subsequent pushes update the same comment
   idempotently rather than stacking new ones.
4. A blocking status check fails on `regression detected` at the
   configured threshold (exit code 3) or on a budget breach (exit code 2).
5. The Action requests only least-privilege permissions, documented per
   feature; provider credentials reach CI only via GitHub secrets and are
   never logged.
6. Fork pull requests run in zero-credential mode: only the simulated and
   Robin-synthetic subjects execute, no provider secret is exposed, and no
   dollar is spent; the comment states the mode.
7. Action releases are integration-tested against a real test pull request
   in CI before publication.

### 6.10 Viewing and diffing traces

1. `assay view` starts a loopback-bound, token-authenticated, read-only
   local server over the trace store and prints the tokenized URL; no
   request leaves the machine and the SPA loads no CDN asset.
2. The run list supports the store's list/get/compare queries: by suite,
   task, variant, adapter, time, and outcome.
3. A trajectory renders turn by turn with model requests, tool calls,
   arguments, results, timings, token counts, cost, and trajectory
   metrics; a 200-turn trajectory renders in under one second at p95.
4. The diff view aligns two runs of the same task turn-by-turn using the
   trajectory alignment keys and marks the first divergent turn.
5. Partial trajectories from crashed or cancelled runs display their
   explicit truncation markers; incomplete captures are labeled, never
   silently smoothed over.
6. The viewer has no mutation endpoint; deletion and export happen only
   through `assay delete` and `assay export`.

### 6.11 Failure recovery

Crashed run:

1. A killed or crashed harness process leaves the store recoverable: WAL
   mode and atomic writes ensure no half-written scored result is read
   back as complete.
2. On next start, quarantine marks records that fail integrity checks
   (`storage_corrupt` is detected and quarantined, never silently
   dropped), the sandbox reaper removes labeled leftovers, and partial
   trajectories persist with truncation markers.
3. The interrupted run's terminal state is preserved; the user re-runs the
   suite and the new run appends alongside the old record.

Unreconciled usage:

1. When provider-reported usage and the harness estimate diverge beyond
   tolerance (1% tokens or $0.01), the run is marked
   `usage_unreconciled`.
2. Budget gates fail closed: an unreconciled run cannot pass a cost
   budget, and the report says exactly why.
3. The user inspects the per-request reconciliation detail in the report,
   corrects the pricing catalog version or investigates the provider
   discrepancy, and re-runs; the unreconciled record remains as evidence.

Sandbox unavailable:

1. Without a reachable Docker socket, sandboxed tasks fail immediately
   with `sandbox_unavailable`, an actionable message naming the probe
   that failed, and exit code 5.
2. `assay doctor` verifies the socket, image availability, and reaper
   state read-only.
3. The user either restores Docker or consciously chooses
   `--unsafe-host-exec`, accepting the persistent report banner; no
   configuration can make host execution silent.

## 7. Functional Requirements

Every requirement below is `planned`. Section 14 maps each requirement to the
release gate in [BUILD_PLAN.md](./BUILD_PLAN.md) whose acceptance evidence
terminally proves it.

### 7.1 Task and suite format (FR-TASK)

- `FR-TASK-001`: Task files are declarative YAML validated against a
  published JSON Schema before any run. A task that does not validate never
  executes, and validation errors name the file, path, and violated rule.
- `FR-TASK-002`: A task declares id, title, fixture, prompt, toolset,
  assertions, budgets, and run policy. Unknown fields are rejected at load
  time rather than ignored, so a typo cannot silently disable a check.
- `FR-TASK-003`: Task and suite files are plain-text, reviewable, and
  diffable, and nothing executes at parse time. A reviewer can approve a
  task change from the diff alone without running untrusted code.
- `FR-TASK-004`: `extends` provides single-parent inheritance with
  documented per-field merge rules and cycle rejection. The effective merged
  task is deterministic and inspectable via `assay validate`.
- `FR-TASK-005`: `matrix` parameterization expands to concrete task
  instances at load time with deterministic, stable instance ids, so matrix
  cells pair correctly across runs and comparisons.
- `FR-TASK-006`: A suite file selects tasks by path and tag with
  deterministic ordering. The same suite file always resolves to the same
  ordered task list for the same tree.
- `FR-TASK-007`: Every task carries `format_version`. Loaders reject unknown
  major versions with a stable `task_invalid` error instead of guessing at
  forward compatibility.
- `FR-TASK-008`: Fixture declarations reference content-addressed fixture
  archives or in-repo directories. No fixture is fetched over the network at
  load time; resolution is local and hash-verifiable.
- `FR-TASK-009`: A task declares its network policy and credential
  requirements explicitly, and the default is none of either. Undeclared
  network access or credentials are never granted implicitly.
- `FR-TASK-010`: `assay validate` validates tasks, suites, checkers, and
  rubrics without running anything: no sandbox, no adapter, no provider, no
  side effects.
- `FR-TASK-011`: Task-format migrations ship with old-version fixtures and
  an explicit migration command. Loaders never silently rewrite a task file
  on disk to a newer format.
- `FR-TASK-012`: Task ids are stable, unique within a suite, and safe for
  use as filesystem paths and database keys; the validator enforces the
  permitted character set and uniqueness.

### 7.2 Runner and lifecycle (FR-RUN)

- `FR-RUN-001`: `assay run` executes a suite for exactly one named variant
  with a declared runs-per-task count (`-n`, default 10). The resolved plan
  is recorded before the first task starts.
- `FR-RUN-002`: Every task run follows the fixed run state machine
  (`planned` through `persisted`, with the terminal states `completed`,
  `failed_infrastructure`, `timed_out`, `cancelled`, and `quarantined`).
  An illegal transition is an `internal_invariant` error, never a warning.
- `FR-RUN-003`: Task outcome (`pass | fail | error`) is orthogonal to run
  lifecycle state. An infrastructure error is never scored as a task
  failure, so flaky infrastructure cannot masquerade as agent regression.
- `FR-RUN-004`: Runs are repeatable: the same suite, variant, seed, and
  adapter produce byte-identical scored results with the simulated agent,
  across runs and across supported platforms.
- `FR-RUN-005`: Parallel task execution is bounded by a configured
  concurrency limit, and records of different runs are never interleaved
  within one trajectory.
- `FR-RUN-006`: Cancellation via SIGINT or SIGTERM terminates agent
  subprocesses and sandboxes, persists a `cancelled` terminal state, and
  exits with code 6. No orphan container or subprocess survives a handled
  cancellation.
- `FR-RUN-007`: A run record binds the suite content hash, per-task content
  hashes, variant, adapter identity, model identity, seeds, and harness
  version, so any two results can be checked for comparability.
- `FR-RUN-008`: Per-task and per-suite timeouts are enforced from
  harness-side monotonic clocks. Agent-side or container-side clocks are
  never the authority for timeout decisions.
- `FR-RUN-009`: Reruns append new run records; they never mutate or
  overwrite a prior run's records. History is append-only evidence.
- `FR-RUN-010`: Exit codes distinguish success, task failures, budget
  breach, comparison regression, invalid input or configuration,
  infrastructure error, and cancellation exactly as specified in
  section 5.1.
- `FR-RUN-011`: A crashed harness process leaves the store recoverable and
  sandboxes reapable on next start; recovery requires no manual database
  surgery.
- `FR-RUN-012`: `--dry-run` prints the resolved execution plan — tasks,
  variants, n, and the estimated spend ceiling from the published cost
  model — and performs no side effects: no sandbox, no adapter, no
  provider call, no store write.

### 7.3 Layered assertions (FR-ASSERT)

- `FR-ASSERT-001`: The deterministic assertion types are `exit_code`,
  `tests_pass`, `file_exists`, `file_contains`, `file_absent`,
  `json_schema`, `diff_matches`, and `command_output`. Each has a published
  schema and defined semantics in [TASK_FORMAT.md](./TASK_FORMAT.md).
- `FR-ASSERT-002`: Assertions evaluate in declared order within a layered
  pipeline: deterministic assertions, then checker assertions, then judge
  assertions. Cheaper layers cannot be reordered after judges, so no judge
  token is spent when a deterministic check already decides the outcome.
- `FR-ASSERT-003`: Checker assertions load a TypeScript module exporting a
  typed `check(ctx)` function and execute it in a restricted worker with
  time and memory limits. A checker cannot reach the network or the harness
  process.
- `FR-ASSERT-004`: A checker crash or timeout is an `assertion_error`,
  reported distinctly from an assertion failure. A broken checker never
  silently converts into a failing task score.
- `FR-ASSERT-005`: Every assertion result carries its type, target,
  observed value, expectation, verdict, and duration, so a report reader
  can see exactly what was compared without re-running anything.
- `FR-ASSERT-006`: Judge assertions are invalid without both a rubric
  reference and a calibration reference; the loader rejects such tasks at
  validation time rather than at judge time.
- `FR-ASSERT-007`: Judge results always carry their agreement metadata
  (percent agreement and Cohen's kappa for the rubric version and judge
  model) in every surface that shows the verdict — report, delta table,
  and viewer alike.
- `FR-ASSERT-008`: Assertion evaluation is hermetic to the sandbox
  workspace snapshot taken after agent exit; assertions cannot observe
  harness host state, host filesystem, or host environment.
- `FR-ASSERT-009`: `diff_matches` compares the workspace against a
  committed expected patch using the context-insensitive matching rules
  defined in [TASK_FORMAT.md](./TASK_FORMAT.md), so unrelated context
  drift does not flip the verdict.
- `FR-ASSERT-010`: `tests_pass` runs a task-declared command inside the
  sandbox and parses its exit status only. It never heuristically parses
  test-runner logs to guess at outcomes.

### 7.4 Trajectory capture and scoring (FR-TRAJ)

- `FR-TRAJ-001`: The trajectory record captures every model request and
  response, every tool call with arguments and result, timings, token
  counts, and cost. Nothing scoring-relevant exists only in memory.
- `FR-TRAJ-002`: Trajectory serialization is canonical and byte-stable for
  identical inputs, so equal trajectories hash equal and golden fixtures
  are diffable.
- `FR-TRAJ-003`: The trajectory metric set comprises tool-selection
  correctness, ordering sanity, redundant-call count, read-before-write
  discipline, error-recovery versus loop classification,
  turns-to-completion, and cost-per-turn, each defined normatively in
  [METHODOLOGY.md](./METHODOLOGY.md).
- `FR-TRAJ-004`: Trajectory assertions can gate on any trajectory metric
  with comparison operators, making trajectory quality a blocking check
  rather than a chart.
- `FR-TRAJ-005`: Trajectory capture is lossless with respect to the
  adapter event stream, or the run is marked incomplete. A partially
  captured trajectory never presents itself as complete.
- `FR-TRAJ-006`: Loop detection distinguishes principled
  retry-after-new-information from repeated identical calls; only the
  latter counts against the agent as looping.
- `FR-TRAJ-007`: Every trajectory record is redacted at the capture
  boundary per ADR-0010 before persistence; no unredacted byte reaches
  disk.
- `FR-TRAJ-008`: Trajectory metrics are versioned. A change to a metric
  definition bumps the metric version; old runs keep their old values and
  are never rescored in place.
- `FR-TRAJ-009`: Partial trajectories from crashed or cancelled runs
  persist with an explicit truncation marker, preserving evidence without
  fabricating completeness.
- `FR-TRAJ-010`: Read-before-write discipline is computed from normalized
  tool semantics declared in the adapter's tool catalog, not from
  tool-name string matching.
- `FR-TRAJ-011`: Turn alignment keys exist in every trajectory so that two
  trajectories of the same task can be diffed turn-by-turn and the first
  divergent turn located.
- `FR-TRAJ-012`: Trajectory capture works identically for simulated,
  Robin-synthetic, and real-provider runs; no code path is exclusive to a
  paid subject.

### 7.5 Budget gates (FR-BUD)

- `FR-BUD-001`: Budgets exist for total tokens, wall-clock milliseconds,
  tool-call count, and dollar cost, and are declarable per task and per
  suite.
- `FR-BUD-002`: A budget breach is a blocking failure distinct from
  assertion failure, with its own exit code (2) and its own report row; a
  budget breach is never folded into a generic task failure.
- `FR-BUD-003`: Budget evaluation uses reconciled usage only. Unreconciled
  usage fails closed: a run marked `usage_unreconciled` cannot pass a cost
  budget.
- `FR-BUD-004`: Budgets compare against the statistical summary across the
  n runs — median and p95 as declared per budget — never against a single
  run, so one outlier neither passes nor fails a budget alone.
- `FR-BUD-005`: A change that holds quality constant while materially
  raising cost fails the build via suite cost budgets. Cost regression is
  a first-class blocking condition, not an annotation.
- `FR-BUD-006`: Latency accounting separates provider latency, tool
  latency, and harness overhead, so a budget verdict attributes time to
  the component that spent it.
- `FR-BUD-007`: Hard runtime kill limits are enforced in the sandbox
  independently of budget accounting; a runaway process is stopped even if
  usage reporting has failed.
- `FR-BUD-008`: A runaway-suite guard aborts the suite when projected
  spend exceeds the declared suite dollar ceiling, failing closed before
  the ceiling is crossed rather than reporting it afterward.

### 7.6 Statistical comparison (FR-STAT)

- `FR-STAT-001`: Results are pass rates over n runs, never single-run
  booleans, in every surface that compares anything. A single run can be
  inspected, but it can never carry a comparative claim.
- `FR-STAT-002`: Per-task pass rates carry 95% Wilson score intervals
  everywhere they render — reports, delta tables, PR comments, and the
  viewer.
- `FR-STAT-003`: Variant deltas use the ADR-0006 method: Newcombe hybrid
  score intervals for the delta and a two-sided Boschloo exact test with
  Fisher exact as the documented fallback. The report names the test used
  and shows the p and q values.
- `FR-STAT-004`: Benjamini-Hochberg FDR control at q = 0.05 applies across
  the per-task tests within one comparison, and both raw and adjusted
  values are shown side by side.
- `FR-STAT-005`: Every comparison report states the minimum detectable
  effect for the actual n used, so a non-detection is read against the
  sensitivity the data actually had.
- `FR-STAT-006`: Flake classification labels each task always-pass
  (k = n), always-fail (k = 0), or unstable (0 < k < n) per the
  [METHODOLOGY.md](./METHODOLOGY.md) definitions, including the stricter
  "genuinely unstable" criterion.
- `FR-STAT-007`: The wording contract is enforced in code: comparing
  surfaces emit only `regression detected`, `improvement detected`,
  `no significant difference at stated MDE`, or `insufficient data`. No
  other result phrase exists.
- `FR-STAT-008`: Statistical self-validation fixtures with injected known
  effects and pure-noise datasets are part of the release gate: the
  pipeline must detect the planted regression and must not fire on noise.
- `FR-STAT-009`: The suite-level delta uses a seeded stratified
  paired-by-task bootstrap (BCa, 10,000 resamples); the seed is recorded
  in the report so the resampling is reproducible.
- `FR-STAT-010`: Comparisons only pair runs with identical task content
  hashes. Any drift between the compared suites aborts the comparison
  with a stable `comparison_invalid` error rather than comparing unlike
  work.
- `FR-STAT-011`: The variant matrix (`assay matrix`) runs suites across
  models, prompt versions, toolset versions, and agent versions and
  produces one comparison report covering the declared cells.
- `FR-STAT-012`: Power and MDE tables for standard n values are published
  in [METHODOLOGY.md](./METHODOLOGY.md) and computed by the same code CI
  uses, so the documentation cannot drift from the implementation.

### 7.7 Judge assertions (FR-JUDGE)

- `FR-JUDGE-001`: A judge assertion requires a written rubric file
  referenced by the task and checked into the suite. Rubric-less judging
  does not exist.
- `FR-JUDGE-002`: Calibration sets hold at least 50 human-labeled
  trajectory excerpts with documented labeling provenance: who labeled,
  under what instructions, from what source runs.
- `FR-JUDGE-003`: Percent agreement and Cohen's kappa are computed and
  stored per rubric version and judge model pair; agreement for one pair
  never stands in for another.
- `FR-JUDGE-004`: A judge assertion may gate only when kappa is at least
  0.6 for its rubric version and judge model; below that threshold it
  reports advisory-only, and every surface says so.
- `FR-JUDGE-005`: The judge model must differ in family from the subject
  agent's model by default. Same-family judging requires
  `allow_same_family_judge: true` in the suite and is flagged in every
  report that includes the judged result.
- `FR-JUDGE-006`: Subject output enters judge prompts only inside
  delimited, provenance-labeled blocks processed by the documented
  isolation transform in [METHODOLOGY.md](./METHODOLOGY.md), which strips
  instruction-shaped content of authority.
- `FR-JUDGE-007`: A red-team suite of manipulation tasks — subject outputs
  that attempt to instruct, flatter, or prompt-inject the judge — runs in
  CI, and detected-manipulation metrics are reported.
- `FR-JUDGE-008`: Judge calls are provider calls: they are cost-accounted,
  reconciled, and budget-gated exactly like any other provider call.
- `FR-JUDGE-009`: Judge non-determinism is handled by k = 3 vote majority;
  the full vote distribution is stored with the verdict, not discarded.
- `FR-JUDGE-010`: Rubric and calibration version together. A rubric change
  invalidates the stored agreement, and the judge may not gate again until
  calibration is re-run against the new rubric version.

### 7.8 CI integration (FR-CI)

- `FR-CI-001`: A GitHub Action wraps `assay run` and `assay compare` with
  pinned action versioning, so a workflow references an exact released
  behavior, never a floating tag semantics change.
- `FR-CI-002`: The Action posts exactly one PR comment containing the
  delta table with confidence intervals, and updates that comment
  idempotently on subsequent pushes instead of stacking duplicates.
- `FR-CI-003`: A blocking status check fails on regression at a
  configurable threshold; the check's failure maps to the wording
  contract's `regression detected` verdict and exit code 3.
- `FR-CI-004`: The Action requires only least-privilege permissions,
  documented per feature: comment posting, status reporting, and nothing
  broader than each enabled feature needs.
- `FR-CI-005`: Provider credentials reach CI only via GitHub secrets. The
  Action never logs them, never echoes them into step output, and never
  writes them into artifacts.
- `FR-CI-006`: Baseline selection — a branch, a tag, or a stored run id —
  is explicit configuration. The Action never guesses a baseline.
- `FR-CI-007`: Fork pull requests run in zero-credential mode: simulated
  and synthetic subjects only, no provider secret exposure, no provider
  spend. The posted comment states the mode.
- `FR-CI-008`: Action integration tests run against a real test pull
  request in CI, exercising comment posting, comment updating, and the
  blocking check end to end.

### 7.9 Trace store and viewer (FR-TRACE)

- `FR-TRACE-001`: All runs persist durably in the ADR-0008 store — one
  SQLite database per project plus a content-addressed blob directory —
  with atomic writes, so a crash never yields a half-written scored
  record.
- `FR-TRACE-002`: The store supports the list, get, and compare queries
  used by reports and the viewer, indexed well enough that comparison
  queries do not scan blobs.
- `FR-TRACE-003`: `assay view` serves the local viewer per ADR-0011: a
  loopback-bound, token-authenticated, read-only HTTP server over the
  trace store, with a bundled SPA making no external requests.
- `FR-TRACE-004`: The viewer renders a full trajectory with turns, tool
  calls, arguments, results, timings, and trajectory metrics.
- `FR-TRACE-005`: The viewer diffs two runs of one task turn-by-turn using
  the trajectory alignment keys and locates the first divergent turn.
- `FR-TRACE-006`: Store schema migrations are explicit (`assay db
  migrate`), forward-only, numbered, and tested against old-version
  fixture databases in CI. Reads never trigger implicit migration.
- `FR-TRACE-007`: `assay export` produces a self-contained redacted
  bundle; `assay delete` removes exactly the selected runs and their
  blobs, nothing more and nothing less.
- `FR-TRACE-008`: The viewer is read-only: no mutation endpoint exists in
  the server, so viewer compromise cannot alter evidence.
- `FR-TRACE-009`: Store corruption is detected and the affected records
  quarantined with diagnostics; corrupt data is never silently dropped or
  silently repaired.
- `FR-TRACE-010`: Retention policy is configurable, with a documented
  default of keep-everything-local per
  [PRIVACY_AND_DATA.md](./PRIVACY_AND_DATA.md).

### 7.10 Sandboxed execution (FR-SAND)

- `FR-SAND-001`: Each task run executes in a dedicated OCI container per
  ADR-0004, driven through the Docker Engine API; containers are never
  shared between task runs.
- `FR-SAND-002`: Fixtures materialize from content-addressed archives via
  tar stream into a container-private workdir volume. The container never
  sees the harness checkout or any host path.
- `FR-SAND-003`: The default network policy is none (`--network none`).
  Task-declared allowlists are explicit, minimal, and downgrade the run's
  isolation label in every report.
- `FR-SAND-004`: No ambient credentials: the container environment
  contains only task-declared variables. Harness credentials, CI secrets,
  and host environment never leak in.
- `FR-SAND-005`: CPU, memory, pids, disk, and wall-clock limits are
  enforced, and a limit breach is the distinct error category
  `sandbox_limit_exceeded`, never a generic failure.
- `FR-SAND-006`: Cleanup is guaranteed: labeled containers and volumes are
  removed on exit, on signal, and by the reaper on next start; `assay gc`
  runs the same pass on demand.
- `FR-SAND-007`: Escape-attempt tests — filesystem escape, network escape,
  process escape, resource exhaustion, and fixture poisoning — run in CI
  and are named in [THREAT_MODEL.md](./THREAT_MODEL.md).
- `FR-SAND-008`: The workspace snapshot used for assertions is taken from
  the container after agent exit and is content-addressed, so an
  assertion's input is exactly identifiable.
- `FR-SAND-009`: Sandbox unavailability (no reachable Docker socket) is a
  stable, actionable `sandbox_unavailable` error. Execution never
  silently degrades to the host.
- `FR-SAND-010`: Host execution exists only behind `--unsafe-host-exec`,
  and every report produced from such a run carries a persistent banner
  stating that isolation was disabled.
- `FR-SAND-011`: Sandbox images are pinned by digest in task and suite
  declarations; a mutable tag is not a valid image reference.
- `FR-SAND-012`: Concurrent sandboxes are isolated from each other:
  separate volumes, no shared writable mounts, no cross-container
  communication path provided by the harness.

### 7.11 Agent adapters (FR-ADAPT)

- `FR-ADAPT-001`: The versioned `assay-adapter/1` contract defines the
  handshake, the newline-delimited JSON event stream on stdout, and
  termination semantics, with the schema published in
  [AGENT_COMPATIBILITY.md](./AGENT_COMPATIBILITY.md).
- `FR-ADAPT-002`: A conformance suite validates adapters against the
  contract and assigns each a conformance tier; tier claims come only
  from conformance results.
- `FR-ADAPT-003`: The simulated adapter ships in-repo and deterministically
  covers text output, tool calls, errors, loops, and budget-relevant
  behavior, proving harness logic with zero external dependencies.
- `FR-ADAPT-004`: The Robin reference adapter wraps `robin --print` with
  stream-JSON output, maps Robin's events onto the contract, and passes
  the conformance suite at its declared tier.
- `FR-ADAPT-005`: Adapter stderr and malformed frames are captured,
  bounded, and classified (`adapter_protocol_error`); a misbehaving
  adapter never crashes the harness.
- `FR-ADAPT-006`: Adapters declare their tool catalog with semantic
  classes — read, write, execute — which trajectory metrics such as
  read-before-write discipline consume.
- `FR-ADAPT-007`: Non-conforming agents can run in the black-box tier:
  final-state assertions only, with the measurement limits of that tier
  stated in every report it produces.
- `FR-ADAPT-008`: The contract carries model identity, token usage, and
  cost fields per model request, feeding the ADR-0009 reconciliation
  pipeline.
- `FR-ADAPT-009`: Adapter processes run inside the sandbox under the
  task's isolation policy; an adapter has no more access than the agent
  it wraps.
- `FR-ADAPT-010`: Contract-version negotiation rejects unknown major
  versions with a stable `adapter_nonconformant` error instead of
  attempting best-effort parsing.

## 8. Failure UX

Every user-facing failure contains:

1. what operation failed;
2. the stable error category from the taxonomy below;
3. whether any state changed (store records, containers, provider spend);
4. the safe next action;
5. the exit code the process will return.

Raw stack traces appear only in explicit debug output. Redaction precedes
both normal and debug rendering. Error categories are stable identifiers:
scripts and alerts may match on them across releases.

The full taxonomy, its user-facing behavior, and its exit-code mapping:

| Category | User-facing behavior | Exit |
| --- | --- | --- |
| `invalid_invocation` | Bad flags or arguments; usage help is shown; nothing ran. | 4 |
| `invalid_configuration` | Merged config failed schema validation or contains unknown keys; the offending key and source are named. | 4 |
| `task_invalid` | A task file failed validation; file, path, and rule are named. | 4 |
| `suite_invalid` | A suite file failed validation or references missing tasks. | 4 |
| `checker_invalid` | A checker module failed to load or lacks the typed export. | 4 |
| `fixture_unavailable` | A declared fixture cannot be resolved locally; no network fetch is attempted. | 5 |
| `fixture_hash_mismatch` | Fixture content does not match its declared hash; the run refuses to materialize it. | 5 |
| `adapter_unavailable` | The adapter executable cannot be spawned; the resolved path is shown. | 5 |
| `adapter_protocol_error` | The adapter emitted malformed frames; bounded captures are stored for diagnosis. | 5 |
| `adapter_nonconformant` | Version negotiation failed or conformance-required behavior is absent. | 5 |
| `sandbox_unavailable` | No reachable Docker socket; the probe that failed is named; no host fallback occurs. | 5 |
| `sandbox_start_failed` | The container could not start; the Docker error is included redacted. | 5 |
| `sandbox_limit_exceeded` | A CPU, memory, pids, or disk limit was breached; reported distinctly from task failure. | 5 |
| `sandbox_timeout` | The harness-side wall-clock kill limit fired; partial trajectory persists with a truncation marker. | 5 |
| `provider_authentication` | The provider rejected the credential; the credential itself is never echoed. | 5 |
| `provider_rate_limit` | The provider throttled; bounded retry policy and its outcome are reported. | 5 |
| `provider_transient` | A retriable provider failure exhausted its retries. | 5 |
| `provider_invalid_response` | The provider returned an unparseable or contract-violating response. | 5 |
| `usage_unreconciled` | Provider-reported and estimated usage diverge beyond 1% tokens or $0.01; budget gates fail closed. | 2 |
| `assertion_error` | A checker crashed or timed out; distinct from a failing assertion. | 5 |
| `judge_unavailable` | The judge model cannot be reached; judged assertions do not silently pass. | 5 |
| `judge_uncalibrated` | A gating judge lacks valid agreement (no calibration, stale rubric, or kappa < 0.6). | 4 |
| `budget_exceeded` | A declared budget gate failed against the run summary. | 2 |
| `comparison_invalid` | Task content hashes drifted between compared results; no verdict is emitted. | 4 |
| `storage_locked` | Another process holds the store; the holder is identified where possible. | 5 |
| `storage_corrupt` | Integrity checks failed; affected records are quarantined, never dropped. | 5 |
| `storage_migration_required` | The store schema is older than the harness; `assay db migrate` is the named next action. | 5 |
| `redaction_failed` | Redaction could not be applied; the record is not persisted and the run fails as infrastructure error. | 5 |
| `cancelled` | The user interrupted; terminal state persisted; sandboxes cleaned. | 6 |
| `internal_invariant` | A harness bug (for example an illegal state transition); a diagnostic reference is printed. | 5 |

Task assertion failures are not in this taxonomy: a failing assertion is a
scored outcome (`fail`) reported through the results surface with exit code
1, not an error.

## 9. Non-Functional Requirements

### 9.1 Determinism (NFR-DET)

- `NFR-DET-001`: Harness CI is fully deterministic: no required check calls
  a live provider. Every required signal is produced by the simulated
  adapter, recorded fixtures, or pure computation.
- `NFR-DET-002`: All harness randomness — sampling, bootstrap resampling,
  ordering jitter — is seeded, and every seed is recorded in the run or
  comparison record.
- `NFR-DET-003`: Clocks are injected dependencies; golden fixtures use
  fixed clocks so timing fields are byte-stable in fixture comparisons.
- `NFR-DET-004`: Simulated-agent end-to-end results are byte-stable across
  repeated runs and across supported platforms; the release gate compares
  bytes, not summaries.
- `NFR-DET-005`: Robin-synthetic end-to-end runs (via `robin --print` on a
  synthetic profile) are deterministic and free, providing integration
  evidence without provider spend.
- `NFR-DET-006`: Recorded-provider fixtures cover the real-provider code
  paths in CI — streaming, usage, retry, and error shapes — without any
  live call.

### 9.2 Cost and performance (NFR-COST)

- `NFR-COST-001`: Required CI spends $0 on providers. Any check that would
  spend money is by definition not a required check.
- `NFR-COST-002`: Nightly paid smoke tests have a per-run cost ceiling of
  at most $5, enforced by Assay's own budget gate rather than by
  convention.
- `NFR-COST-003`: The cost model — suite size times n times pricing yields
  projected spend — is published and is the same computation `--dry-run`
  prints.
- `NFR-COST-004`: The runaway-suite guard aborts at the declared suite
  dollar ceiling, fail-closed.
- `NFR-COST-005`: Harness overhead per task run, excluding agent
  execution time, is under 2 seconds at p95.
- `NFR-COST-006`: The viewer renders a 200-turn trajectory from the local
  store in under 1 second at p95.

### 9.3 Security (NFR-SEC)

- `NFR-SEC-001`: No secret appears in argv, config files, logs, traces,
  reports, or export bundles, evidenced by the planted-credential corpus
  (raw, split, base64, URL-embedded, in tool output, in trajectory
  arguments).
- `NFR-SEC-002`: Sandbox isolation claims are bounded and escape-tested
  per [THREAT_MODEL.md](./THREAT_MODEL.md); the shared-kernel boundary
  and out-of-scope threats are stated wherever the claim is made.
- `NFR-SEC-003`: Judge manipulation defenses are adversarially tested by
  the red-team suite; a defense without a test is not a claim.
- `NFR-SEC-004`: BYOK credentials resolve at spawn time from environment
  or OS keychain references and are never persisted by Assay in any
  store, file, or bundle.
- `NFR-SEC-005`: The viewer binds loopback only, with a per-session
  token; there is no configuration that exposes it beyond the local
  machine.
- `NFR-SEC-006`: Dependency intake follows the review gate: exact-pinned
  versions, lockfile review, and lockfile-only installs in CI.
- `NFR-SEC-007`: Fixture archives are hash-verified before
  materialization; a mismatch stops the run before any byte reaches a
  container.
- `NFR-SEC-008`: The GitHub Action is least-privilege and published with
  provenance, so consumers can verify what they execute.

### 9.4 Privacy (NFR-PRIV)

- `NFR-PRIV-001`: All data is local by default. The only egress is an
  explicit provider call the user configured; nothing else leaves the
  machine.
- `NFR-PRIV-002`: Traces are redacted before persistence at the capture
  boundary; there is no window in which unredacted data rests on disk.
- `NFR-PRIV-003`: Export, deletion, and retention behave exactly as
  specified in [PRIVACY_AND_DATA.md](./PRIVACY_AND_DATA.md), including
  dry-run inventories for deletion.
- `NFR-PRIV-004`: Diagnostics bundles enumerate their contents and pass
  redaction before writing; a bundle that cannot be redacted is not
  written.
- `NFR-PRIV-005`: Per-provider egress documentation is complete and
  accurate: what is sent, to whom, and under which configuration.
- `NFR-PRIV-006`: No telemetry exists in 1.0 — no usage pings, no crash
  reporting, no update checks that transmit identifying data.

### 9.5 Maintainability (NFR-MAINT)

- `NFR-MAINT-001`: Repository architecture checks enforce package
  boundaries in CI; a dependency edge that violates
  [ARCHITECTURE.md](./ARCHITECTURE.md) fails the build.
- `NFR-MAINT-002`: Mutation testing gates the stats and scoring packages
  at a mutation score of at least 85%, because these packages produce the
  verdicts everything else defends.
- `NFR-MAINT-003`: Every public contract — task format, adapter contract,
  event union, store schema, Action inputs — is versioned before 1.0.
- `NFR-MAINT-004`: Docs current-versus-planned statements are enforced by
  a docs check in CI; a claim of implemented behavior without gate
  evidence fails the check.
- `NFR-MAINT-005`: Golden fixtures are regenerated only by an explicit
  command with semantic review of the diff; a test run never rewrites its
  own expectations.
- `NFR-MAINT-006`: All packages build from a clean clone with one
  bootstrap command; no undocumented local setup exists.

## 10. Product Differentiation

Assay does not differentiate by pretending the market is empty. promptfoo,
Braintrust, LangSmith, OpenAI Evals, and inspect-ai are real, capable, and
described accurately in [LANDSCAPE.md](./LANDSCAPE.md). Assay makes exactly
three claims, together, and no more:

1. **Trajectory-first scoring.** Assay's unit of evaluation is the full
   turn-by-turn trajectory — tool selection, ordering, redundancy, loop
   behavior, read-before-write discipline, cost per turn — with versioned
   metric definitions and trajectory assertions that gate. Products that
   score final answers, or that record trajectories without making them
   gateable, do a different job.
2. **Budgets that block.** Token, latency, tool-call, and dollar budgets
   are pass/fail gates evaluated against reconciled usage and statistical
   summaries across runs, with their own exit code. A cost regression with
   flat quality fails the build. Observability products chart this; Assay
   blocks on it.
3. **Statistics or silence in a CI gate.** Assay is, per
   [LANDSCAPE.md](./LANDSCAPE.md), the only harness purpose-built to block
   a pull request on a statistically defended trajectory-quality or cost
   regression of a coding agent, runnable entirely locally against a
   deterministic synthetic agent for zero dollars. Every verdict carries
   its test, intervals, FDR-adjusted values, and stated power, because a
   blocked PR must be contestable.

Where a competitor does something well, LANDSCAPE.md says so. A comparison
that flatters Assay by omission is a documentation defect.

## 11. Compatibility Claims

Assay never claims that an arbitrary agent binary is automatically
evaluable. An agent is evaluable at trajectory depth only through an adapter
that speaks the versioned `assay-adapter/1` contract; anything else is
limited to final-state observation with stated limits. The public tiers,
assigned only by conformance-suite results per
[AGENT_COMPATIBILITY.md](./AGENT_COMPATIBILITY.md):

| Tier | Claim |
| --- | --- |
| Conformant adapter | The adapter passes the full `assay-adapter/1` conformance suite. Trajectory capture, trajectory metrics, budget accounting, and usage reconciliation are all available. |
| Pinned-preview | The adapter passes conformance against one exact pinned upstream version and preview flag spelling. Claims are valid only for that pin. The Robin reference adapter holds this tier until Robin's R7 automation-contract freeze, when it re-verifies. |
| Black-box | No conforming adapter exists. The agent runs and only final workspace state is asserted. Reports state the measurement limits: no trajectory metrics, no per-request usage, no turn-level diffing. |
| Unsupported experiment | Manually wired for development; excluded from release claims and the support matrix. |

The Robin integration boundary is fixed: Robin is the first subject under
test, driven through `adapter-robin` as a subprocess only. Robin's
deterministic credential-free synthetic provider makes Assay's Robin
end-to-end suite deterministic and free; Assay pins the tested Robin
version, commit, and preview flag spellings. Assay's own logic is proven one
level lower by `adapter-simulated`, which requires no Robin at all:
Robin-synthetic e2e is integration evidence, simulated e2e is the required
deterministic gate evidence. Assay never uses a paid live provider to prove
logic a synthetic subject can prove.

## 12. Release Acceptance Hierarchy

The gates below are defined and evidenced in
[BUILD_PLAN.md](./BUILD_PLAN.md). Each subsection states what may be claimed
publicly once that gate is accepted. Nothing may be claimed for a gate that
has not been accepted.

Current state, stated verbatim wherever the current state is described:

> Assay is under implementation. Gates R0 and R1 have code and local evidence
> on gate branches, but neither is accepted: R0 is blocked by unavailable
> private-repository branch protection and review controls on the current GitHub
> plan, and R1 depends on accepted R0. No product gate is accepted.

### 12.1 R0 — Repository, toolchain, and CI identity

When accepted: the repository, toolchain, CI pipeline, and architecture
checks exist and are green. Claimable: the project builds from a clean clone
with one bootstrap command and its package boundaries are enforced. No
product behavior may be claimed.

### 12.2 R1 — Task format, runner, and deterministic assertions

When accepted: a suite runs against the simulated agent and produces a
byte-reproducible result. Claimable: task authoring, validation, the runner
state machine, deterministic and checker assertions, exit codes, append-only
persistence in the store core, and deterministic zero-dollar CI. Not
claimable: sandboxing, real providers, trajectory metrics, budgets,
statistics, judging, CI integration, or the viewer.

### 12.3 R2 — Sandboxed execution

When accepted: fixtures materialize in an isolated container with enforced
limits and guaranteed cleanup, even after a killed run. Claimable: the
bounded sandbox isolation story with its named escape tests, default-deny
networking, no-ambient-credentials execution, and guaranteed reaping. The
isolation claim is always stated with its boundary: shared kernel through
the container runtime; a compromised kernel or Docker daemon is out of the
defended boundary.

### 12.4 R3 — Real providers, BYOK, and usage accounting

When accepted: a real provider runs through BYOK with token, cost, and
latency accounting reconciled against provider-reported usage. Claimable:
BYOK execution, the pricing catalog, fail-closed reconciliation, and the
per-provider egress documentation. Required CI remains zero-spend.

### 12.5 R4 — Trajectory capture and scoring

When accepted: complete trajectories are captured and scored against
trajectory assertions. Claimable: lossless capture, canonical serialization,
the versioned metric set, capture-boundary redaction, and identical capture
across simulated, Robin-synthetic, and real subjects; the conformance suite
and adapter tiers.

### 12.6 R5 — Budget gates

When accepted: a run exceeding a declared token, time, call-count, or dollar
threshold fails. Claimable: budgets as blocking gates, summary-based budget
evaluation, the runaway-suite guard, `--dry-run` spend ceilings, and the
published cost model.

### 12.7 R6 — Statistical comparison

When accepted: a known injected regression is detected and injected noise
does not fire. Claimable: the full ADR-0006 statistical pipeline, the
wording contract, MDE reporting, flake classification, the variant matrix,
and the mutation-tested stats package. Only after R6 may any Assay surface
or document use the phrase `regression detected` about a real comparison.

### 12.8 R7 — Judge assertions and red-team

When accepted: judge results ship with calibration agreement, and the
manipulation red-team suite passes. Claimable: calibrated judging, the kappa
gate, cross-family policy, isolation transforms, k-vote handling, and
adversarially tested judge defenses.

### 12.9 R8 — CI integration

When accepted: a GitHub Action posts a delta table and blocks a PR on a
threshold breach. Claimable: the flagship demonstration of section 1.2 in
full, the idempotent PR comment, the blocking check, fork-PR zero-credential
mode, and least-privilege permissions. Acceptance of R8 with all prior gates
green constitutes the first usable release. A soft launch per
[MARKETING.md](./MARKETING.md) may follow R8; every published claim maps to
an accepted gate.

### 12.10 R9 — Trace store and viewer

When accepted: two runs of one task are rendered, diffed, and the divergent
turn located. Claimable: the local read-only viewer, trajectory rendering,
turn diffing, loopback-plus-token binding, and the viewer performance
target.

### 12.11 R10 — Packaging, operations, and 1.0

When accepted: packaging, install, docs, migration, and a published public
result set satisfy the 1.0 gate. Claimable: Assay 1.0 — versioned public
contracts, tested migrations, export/delete/retention behavior, the
provenance-published Action, the planted-corpus secret evidence across all
surfaces including bundles, and the public 1.0 launch per
[MARKETING.md](./MARKETING.md) after the claim audit.

## 13. Success Measures

Before the public 1.0 launch, Assay records reproducible measurements for:

- time from clean clone to first green simulated-agent suite run;
- byte-reproducibility rate of simulated-agent results across platforms;
- injected-regression detection rate and pure-noise false-fire rate of the
  statistical self-validation fixtures;
- sandbox cleanup success after normal exit, signal, and injected crash
  (orphan container count must be zero);
- planted-credential corpus escape count across traces, logs, reports, and
  bundles (must be zero);
- usage reconciliation pass rate on recorded real-provider fixtures;
- judge-to-human agreement (percent and kappa) on the reference rubric;
- red-team manipulation detection metrics;
- Action end-to-end success on the real test PR, including comment
  idempotency across pushes;
- harness overhead p95 per task run and viewer render p95 at 200 turns;
- percentage of failures carrying a stable category and safe next action.

Measurements use synthetic and repository-owned fixtures. Success metrics
never justify collecting user repository content or adding telemetry.

## 14. Requirement-to-Evidence Rule

Every functional and non-functional requirement in this document maps to
exactly one release gate in [BUILD_PLAN.md](./BUILD_PLAN.md) that terminally
owns it: the gate whose acceptance evidence proves the requirement.
Earlier gates may begin work on a requirement, but only the owning gate's
named evidence completes it. A requirement is not complete because a type,
schema, stub, or happy-path unit test exists; it is complete when the owning
gate's test-driven evidence matrix passes on mainline.

A claim of implemented behavior without an accepted owning gate is a
documentation defect, enforced by the docs check (`NFR-MAINT-004`). The
same rule binds [MARKETING.md](./MARKETING.md): a marketing claim without an
accepted gate behind it is a documentation defect.

The terminal ownership register:

| Requirement | Owning gate |
| --- | --- |
| FR-TASK-001 | R1 |
| FR-TASK-002 | R1 |
| FR-TASK-003 | R1 |
| FR-TASK-004 | R1 |
| FR-TASK-005 | R1 |
| FR-TASK-006 | R1 |
| FR-TASK-007 | R1 |
| FR-TASK-008 | R2 |
| FR-TASK-009 | R2 |
| FR-TASK-010 | R1 |
| FR-TASK-011 | R10 |
| FR-TASK-012 | R1 |
| FR-RUN-001 | R1 |
| FR-RUN-002 | R1 |
| FR-RUN-003 | R1 |
| FR-RUN-004 | R1 |
| FR-RUN-005 | R2 |
| FR-RUN-006 | R2 |
| FR-RUN-007 | R1 |
| FR-RUN-008 | R2 |
| FR-RUN-009 | R1 |
| FR-RUN-010 | R1 |
| FR-RUN-011 | R2 |
| FR-RUN-012 | R5 |
| FR-ASSERT-001 | R1 |
| FR-ASSERT-002 | R1 |
| FR-ASSERT-003 | R1 |
| FR-ASSERT-004 | R1 |
| FR-ASSERT-005 | R1 |
| FR-ASSERT-006 | R7 |
| FR-ASSERT-007 | R7 |
| FR-ASSERT-008 | R2 |
| FR-ASSERT-009 | R1 |
| FR-ASSERT-010 | R2 |
| FR-TRAJ-001 | R4 |
| FR-TRAJ-002 | R4 |
| FR-TRAJ-003 | R4 |
| FR-TRAJ-004 | R4 |
| FR-TRAJ-005 | R4 |
| FR-TRAJ-006 | R4 |
| FR-TRAJ-007 | R4 |
| FR-TRAJ-008 | R4 |
| FR-TRAJ-009 | R4 |
| FR-TRAJ-010 | R4 |
| FR-TRAJ-011 | R9 |
| FR-TRAJ-012 | R4 |
| FR-BUD-001 | R5 |
| FR-BUD-002 | R5 |
| FR-BUD-003 | R5 |
| FR-BUD-004 | R5 |
| FR-BUD-005 | R5 |
| FR-BUD-006 | R5 |
| FR-BUD-007 | R2 |
| FR-BUD-008 | R5 |
| FR-STAT-001 | R6 |
| FR-STAT-002 | R6 |
| FR-STAT-003 | R6 |
| FR-STAT-004 | R6 |
| FR-STAT-005 | R6 |
| FR-STAT-006 | R6 |
| FR-STAT-007 | R6 |
| FR-STAT-008 | R6 |
| FR-STAT-009 | R6 |
| FR-STAT-010 | R6 |
| FR-STAT-011 | R6 |
| FR-STAT-012 | R6 |
| FR-JUDGE-001 | R7 |
| FR-JUDGE-002 | R7 |
| FR-JUDGE-003 | R7 |
| FR-JUDGE-004 | R7 |
| FR-JUDGE-005 | R7 |
| FR-JUDGE-006 | R7 |
| FR-JUDGE-007 | R7 |
| FR-JUDGE-008 | R7 |
| FR-JUDGE-009 | R7 |
| FR-JUDGE-010 | R7 |
| FR-CI-001 | R8 |
| FR-CI-002 | R8 |
| FR-CI-003 | R8 |
| FR-CI-004 | R8 |
| FR-CI-005 | R8 |
| FR-CI-006 | R8 |
| FR-CI-007 | R8 |
| FR-CI-008 | R8 |
| FR-TRACE-001 | R1 |
| FR-TRACE-002 | R9 |
| FR-TRACE-003 | R9 |
| FR-TRACE-004 | R9 |
| FR-TRACE-005 | R9 |
| FR-TRACE-006 | R10 |
| FR-TRACE-007 | R10 |
| FR-TRACE-008 | R9 |
| FR-TRACE-009 | R1 |
| FR-TRACE-010 | R10 |
| FR-SAND-001 | R2 |
| FR-SAND-002 | R2 |
| FR-SAND-003 | R2 |
| FR-SAND-004 | R2 |
| FR-SAND-005 | R2 |
| FR-SAND-006 | R2 |
| FR-SAND-007 | R2 |
| FR-SAND-008 | R2 |
| FR-SAND-009 | R2 |
| FR-SAND-010 | R2 |
| FR-SAND-011 | R2 |
| FR-SAND-012 | R2 |
| FR-ADAPT-001 | R1 |
| FR-ADAPT-002 | R4 |
| FR-ADAPT-003 | R1 |
| FR-ADAPT-004 | R4 |
| FR-ADAPT-005 | R1 |
| FR-ADAPT-006 | R4 |
| FR-ADAPT-007 | R4 |
| FR-ADAPT-008 | R3 |
| FR-ADAPT-009 | R2 |
| FR-ADAPT-010 | R1 |
| NFR-DET-001 | R1 |
| NFR-DET-002 | R1 |
| NFR-DET-003 | R1 |
| NFR-DET-004 | R1 |
| NFR-DET-005 | R4 |
| NFR-DET-006 | R3 |
| NFR-COST-001 | R1 |
| NFR-COST-002 | R3 |
| NFR-COST-003 | R5 |
| NFR-COST-004 | R5 |
| NFR-COST-005 | R2 |
| NFR-COST-006 | R9 |
| NFR-SEC-001 | R10 |
| NFR-SEC-002 | R2 |
| NFR-SEC-003 | R7 |
| NFR-SEC-004 | R3 |
| NFR-SEC-005 | R9 |
| NFR-SEC-006 | R0 |
| NFR-SEC-007 | R2 |
| NFR-SEC-008 | R10 |
| NFR-PRIV-001 | R3 |
| NFR-PRIV-002 | R4 |
| NFR-PRIV-003 | R10 |
| NFR-PRIV-004 | R10 |
| NFR-PRIV-005 | R3 |
| NFR-PRIV-006 | R10 |
| NFR-MAINT-001 | R0 |
| NFR-MAINT-002 | R6 |
| NFR-MAINT-003 | R10 |
| NFR-MAINT-004 | R0 |
| NFR-MAINT-005 | R1 |
| NFR-MAINT-006 | R0 |

Two ownership notes clarify entries that span gates. `NFR-SEC-001` begins at
R4 (capture-boundary redaction of traces) and is terminally owned by R10,
whose bundle evidence proves the property across every surface including
exports. `FR-TRACE-001` is owned by R1 because the durable store core with
atomic writes is R1 evidence; the viewer-facing store requirements
(`FR-TRACE-002` through `FR-TRACE-005`, `FR-TRACE-008`) are owned by R9.

The complete gate-by-gate evidence matrix — test names, first failing
conditions, and required passing assertions per requirement — lives in
[BUILD_PLAN.md](./BUILD_PLAN.md) section 16 and is the operational form of
this register.
