# Assay: Glossary

Canonical definitions for the controlled vocabulary used across the planning
documents, in alphabetical order. When another document appears to conflict
with a definition here, fix the conflict rather than redefining the term
locally. Every capability named here is planned; no term implies implemented
behavior.

- **Adapter** — a subprocess that presents one subject agent to the harness
  by speaking the adapter contract on stdout. Adapters run inside the
  sandbox under the task's isolation policy and never share a process with
  the harness.

- **Adapter contract (`assay-adapter/1`)** — the versioned newline-delimited
  JSON contract an adapter speaks: handshake, event stream, per-request
  model identity, usage and cost fields, and termination. Unknown major
  versions are rejected with a stable error. Schema in
  AGENT_COMPATIBILITY.md.

- **Assertion (layered)** — a declared check on a task run. Layers evaluate
  in fixed order: deterministic (exit_code, tests_pass, file checks, schema,
  diff, command output), then checker, then judge. Cheaper layers are never
  reordered after judges. An assertion error is distinct from an assertion
  failure.

- **Baseline** — the reference suite result a candidate is compared against
  in `assay compare`; selected explicitly by branch, tag, or stored run id.
  Comparisons pair only runs with identical task content hashes.

- **Black-box tier** — the conformance tier for agents that cannot speak the
  adapter contract: final-state assertions only, with the measurement limits
  stated in every report that includes the result. No trajectory metrics.

- **Budget gate** — a blocking pass/fail check on total tokens, wall-clock
  milliseconds, tool-call count, or dollar cost, declared per task or per
  suite. Breach is distinct from assertion failure, has its own exit code,
  and evaluates reconciled usage summaries (median and p95 as declared),
  never a single run.

- **BYOK** — bring your own key. Provider credentials resolve at spawn time
  from environment or OS keychain references and are never persisted by
  Assay.

- **Calibration set** — at least 50 human-labeled trajectory excerpts, with
  documented labeling provenance, against which a judge's agreement is
  measured per rubric version and judge model. Rubric changes invalidate the
  agreement.

- **Checker** — a task-referenced TypeScript module exporting a typed
  `check(ctx)` function, executed in a restricted worker with time and
  memory limits. A checker crash or timeout is an assertion error, not a
  failure.

- **Comparison report** — the output of `assay compare`: per-task deltas
  with Newcombe hybrid intervals, named tests with raw and BH-adjusted
  values, the suite-level bootstrap delta with its recorded seed, the MDE
  for the n used, and verdicts phrased only per the wording contract.

- **Conformance tier** — the level an adapter earns from the conformance
  suite, determining which measurements its results may claim. Tiers are
  computed by the harness, never accepted from adapter self-description.

- **Delta table** — the per-task table in a comparison report and in the CI
  pull-request comment: baseline rate, candidate rate, delta with 95%
  interval, adjusted q value, and verdict.

- **Fixture** — the content-addressed archive or in-repo directory a task
  materializes into the sandbox workdir. Hash-verified before
  materialization; never fetched from the network at load time.

- **Flake classes** — the per-task stability labels over n runs:
  `always_pass` (k = n), `always_fail` (k = 0), `unstable` (0 < k < n).
  "Genuinely unstable" additionally requires a Wilson interval excluding
  both 0 and 1 at n ≥ 10.

- **Gate** — one of the eleven release gates R0–R10 in BUILD_PLAN.md. Each
  names the evidence that unlocks it; a claim of accepted status without
  that evidence is a documentation defect.

- **Isolation label** — the per-run record of the sandbox posture actually
  applied. A task-declared network allowlist downgrades the label from the
  default of no network.

- **Judge assertion** — an LLM-as-judge check, valid only with a checked-in
  rubric and a calibration reference. It may gate only when Cohen's kappa
  is at least 0.6; below that it reports advisory-only. Verdicts use k = 3
  majority voting with the vote distribution stored, and always carry
  agreement metadata.

- **MDE** — minimum detectable effect: the smallest true difference the
  comparison had 80% power to detect at the n actually used. Every
  comparison report states it; "no significant difference" is always "at
  the stated MDE".

- **Pass rate** — the fraction of a task's n runs whose outcome is pass.
  The unit of every comparing surface; a single-run boolean is never a
  quality claim.

- **Pinned-preview tier** — the Robin reference adapter's conformance tier
  until Robin's automation contract freezes at Robin's R7 gate: the adapter
  pins the exact tested Robin version and preview flag spellings and
  re-verifies at the freeze.

- **Redaction boundary** — the capture boundary at which the versioned
  pattern ruleset and entropy scanner run, before any byte is persisted or
  leaves the process. Redaction failure fails closed: the record is not
  persisted and the run fails as infrastructure error.

- **Regression** — a verdict permitted only by the wording contract: the
  named statistical test, after FDR adjustment, rejects no-difference in
  the harmful direction at the stated threshold. Any other use of the word
  in a result surface is a defect.

- **Rubric** — the written scoring instruction file a judge assertion
  references, checked into the suite and versioned together with its
  calibration set.

- **Run / task run / suite run** — a *task run* is one execution of one
  task in one sandbox; a *suite run* is the recorded execution of a suite
  for one variant at a declared n per task; *run* unqualified means suite
  run. Task runs follow the fixed lifecycle state machine, and reruns
  append rather than mutate.

- **Sandbox** — the dedicated OCI container each task run executes in:
  materialized fixture, no network by default, read-only root, tmpfs
  scratch, resource limits, no ambient credentials, and guaranteed cleanup
  of labeled containers. Isolation is bounded: the kernel is shared with
  the host through the container runtime.

- **Simulated adapter** — the in-repo deterministic scripted agent
  (`adapter-simulated`) covering text, tool calls, errors, loops, and
  budget-relevant behavior. It proves harness logic with zero external
  dependencies and zero cost, and produces byte-stable results.

- **Subject agent** — the agent under test, reached only through an
  adapter subprocess. Robin is the first subject; the harness never links
  a subject in-process.

- **Suite** — a YAML file selecting tasks by path and tag with
  deterministic ordering, plus suite-level budgets and comparison policy.
  A suite content hash binds every run record.

- **Task** — the declarative YAML unit of evaluation: id, title, fixture,
  prompt, toolset, sandbox spec, assertions, budgets, and run policy,
  validated against a published JSON Schema before any run. Unknown fields
  are rejected.

- **Trace store** — the local-first record of everything: one SQLite
  database per project (`.assay/assay.db`, WAL mode) plus a
  content-addressed blob directory for trajectory JSONL, tool output, and
  fixture manifests. Migrations are explicit and forward-only.

- **Trajectory** — the complete captured turn-by-turn record of a task
  run: every model request and response, every tool call with arguments
  and result, timings, token counts, and cost, in canonical byte-stable
  serialization, redacted at capture.

- **Trajectory metric** — a versioned score computed from a trajectory.
  The seven metrics: tool-selection correctness, ordering sanity,
  redundant-call count, read-before-write discipline, error-recovery
  versus loop, turns-to-completion, and cost-per-turn. Trajectory
  assertions gate on any of them with comparison operators.

- **Usage reconciliation** — the per-request and per-run check of
  provider-reported usage against the harness's pricing-catalog estimate.
  Discrepancy above 1% of tokens or $0.01 marks the run
  `usage_unreconciled`, which fails budget gates closed.

- **Variant** — one named configuration under comparison: a model, prompt
  version, toolset version, or agent version. `assay run` executes a suite
  for exactly one variant.

- **Variant matrix** — the declared cross-product of variants that
  `assay matrix` runs across models, prompt versions, toolset versions,
  and agent versions, producing one comparison report.

- **Wilson interval** — the 95% Wilson score confidence interval attached
  to every rendered pass rate. Chosen over the normal approximation for
  honest coverage at small n and extreme rates.

- **Wording contract** — the closed set of permitted result phrases:
  "regression detected", "improvement detected", "no significant
  difference at the stated MDE", and "insufficient data" (required
  whenever n is below 5). Reporting code emits nothing else.

Last revised: 2026-08-30.
