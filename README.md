# Assay

Assay is an evaluation harness for coding and tool-using agents that treats
evals as a CI gate rather than a dashboard. Three claims distinguish it, and
they are always stated together:

1. It scores **trajectories** — the full turn-by-turn record of model
   requests, tool calls, and results — not just final answers.
2. It enforces **cost and latency budgets** as blocking pass/fail checks.
3. It treats **stochastic comparison as a statistics problem**: it refuses
   to call a difference a regression without a significance test,
   confidence intervals, and stated power.

The market for agent evals is not empty, and Assay does not pretend it is.
Its narrow defensible claim: **the only harness purpose-built to block a
pull request on a statistically defended trajectory-quality or cost
regression of a coding agent, runnable entirely locally against a
deterministic synthetic agent for zero dollars.**

## Implementation Status

> Assay is under implementation. Gate R0 code and CI evidence exist on an
> open pull request, but R0 is not accepted because required private-repository
> branch protection and review controls are unavailable on the current GitHub
> plan. No later product gate is accepted.

The product commands, metrics, and evaluation guarantees in this README remain
planned. The table below is the complete honest inventory.

| Area | Exists now | Planned |
| --- | --- | --- |
| Documentation | The normative set plus an R0 docs/status checker on the open gate branch | Gate-by-gate current-versus-planned updates |
| Code | R0 Node 22 workspace skeleton, contracts, schemas, and tests on the open gate branch; no evaluation runner | Product packages added only by their owning gates |
| CLI | Bootstrap `--help` and `--version` only on the open gate branch; product commands reject | `assay init/validate/run/compare/report/matrix/judge/view/gc/db/export/delete/doctor/redact-check` |
| Sandbox | None | Per-run OCI containers, no network by default, guaranteed cleanup (ADR-0004) |
| Statistics | None | Wilson intervals, exact tests, FDR control, seeded bootstrap, MDE reporting (ADR-0006) |
| CI integration | Deterministic R0 branch CI is green; required private-repo protection is plan-blocked | GitHub Action posting a delta table and blocking on regression (R8) |
| Evidence | R0 local and branch-CI evidence exists, but R0 is not accepted | Gate-by-gate acceptance evidence per `docs/BUILD_PLAN.md` |

## Landscape

Assay is entering an occupied field and names it plainly; the full analysis
is in [docs/LANDSCAPE.md](docs/LANDSCAPE.md).

- **promptfoo** is a strong local-first eval and red-teaming CLI for prompts
  and LLM apps, with a mature assertion library.
- **Braintrust** is a polished hosted eval and observability platform with
  first-class experiment tracking for LLM products.
- **LangSmith** is the LangChain ecosystem's hosted tracing and evaluation
  suite, strongest where LangChain is already in use.
- **OpenAI Evals** is a registry and framework for benchmarking model
  behavior, oriented toward model comparison rather than CI gating.
- **inspect-ai** is a rigorous open-source research eval framework with real
  trajectory and tool-use support, oriented toward safety evaluations.

Assay's difference is the narrow claim above: statistically defended,
budget-aware, trajectory-level PR blocking, locally, for zero dollars in the
deterministic tier.

## Planned Quick Start

**Planned — none of these commands exist yet.** This section shows the
intended workflow the requirements bind; it is a specification, not usage.

Contributor step 1, before any toolchain work, is authenticating the GitHub
CLI (this is ticket R0.01 and the first bootstrap step in
[docs/OPERATIONS_TEST_PLAN.md](docs/OPERATIONS_TEST_PLAN.md)):

```text
$ gh auth login
✓ Logged in to github.com

$ gh auth status
✓ Logged in to github.com account <you> (keyring)
✓ Token scopes: repo, workflow

$ gh api user
{ "login": "<you>", … }
```

The intended user workflow:

```text
$ assay init
Created assay.config.yaml, .assay/, and an example suite.

$ assay validate suites/coding-core.yaml
12 tasks valid against task schema 1.0; 0 errors.

$ assay run suites/coding-core.yaml --variant baseline -n 10 --seed 42
$ assay run suites/coding-core.yaml --variant candidate -n 10 --seed 42

$ assay compare baseline candidate --threshold 0.05
Suite: coding-core   n = 10 runs/task/variant   seed = 42

| Task            | Baseline rate     | Candidate rate    | Delta (95% CI)        | q     | Verdict             |
|-----------------|-------------------|-------------------|-----------------------|-------|---------------------|
| fix-null-deref  | 0.90 [0.60, 0.98] | 0.40 [0.17, 0.69] | -0.50 [-0.78, -0.08]  | 0.032 | regression detected |
| add-cli-flag    | 0.80 [0.49, 0.94] | 0.90 [0.60, 0.98] | +0.10 [-0.22, 0.41]   | 0.611 | no significant difference detected (minimum detectable effect at n=10: 42 pp) |
| refactor-store  | 1.00 [0.72, 1.00] | 1.00 [0.72, 1.00] | 0.00 [-0.28, 0.28]    | 1.000 | no significant difference detected (minimum detectable effect at n=10: 42 pp) |

Suite delta: -0.13 [-0.24, -0.03]
(stratified paired-by-task bootstrap, BCa, B = 10,000, seed 42)
MDE at n = 10: 0.42 per task at power 0.8. Boschloo exact, BH FDR q = 0.05.
Cost: candidate median $0.048/task vs budget $0.040/task — budget breach.

exit code 3 (regression detected)

$ assay view
Viewer on http://127.0.0.1:4780 (loopback only, token in terminal).
```

Exit codes are fixed by the requirements: 0 success or no regression, 1 task
failures, 2 budget breach, 3 regression detected, 4 invalid input or
configuration, 5 infrastructure error, 6 cancelled.

## What a Task Looks Like (Planned)

Tasks are declarative YAML, validated against a published JSON Schema
before any run, reviewable and diffable in a PR. A sketch of the planned
format defined in [docs/TASK_FORMAT.md](docs/TASK_FORMAT.md):

```yaml
format_version: "1.0"
id: fix-null-deref
title: Fix the null dereference in the account service
tags: [bugfix, core]
fixture: repos/account-service@sha256:9f2c…
prompt: >
  The account test suite fails with a null dereference. Find the cause
  and fix it without changing public behavior.
sandbox:
  image: node22-ci@sha256:41ab…
  network: none
assertions:
  - type: tests_pass
    command: npm test
  - type: trajectory_metric
    metric: redundant_call_count
    op: "<="
    value: 2
budgets:
  tokens: 60000
  wall_clock_ms: 300000
  dollars: 0.05
```

Assertions evaluate in layers — deterministic checks first, then
TypeScript checker functions in a restricted worker, then (only when
declared, calibrated, and flagged) LLM judge assertions. Budget breach is
a distinct failure with its own exit code, never folded into quality.

## Release Gates

The build plan defines eleven gates. Each unlocks specific evidence; R0 is in
progress and no gate is accepted. The full definitions, tickets, and dependency edges are in
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

| Gate | Title | Evidence unlocked | Status |
| --- | --- | --- | --- |
| R0 | Repository, toolchain, and CI identity | Repository, toolchain, CI, and architecture checks exist and are green. | in progress |
| R1 | Task format, runner, and deterministic assertions | A suite runs against the simulated agent and produces a byte-reproducible result. | planned |
| R2 | Sandboxed execution | Fixtures materialize in an isolated container with enforced limits and guaranteed cleanup, even after a killed run. | planned |
| R3 | Real providers, BYOK, and usage accounting | A real provider runs through BYOK with token, cost, and latency accounting reconciled against provider-reported usage. | planned |
| R4 | Trajectory capture and scoring | Complete trajectories are captured and scored against trajectory assertions. | planned |
| R5 | Budget gates | A run exceeding a declared token, time, call-count, or dollar threshold fails. | planned |
| R6 | Statistical comparison | A known injected regression is detected; injected noise does not fire. | planned |
| R7 | Judge assertions and red-team | Judge results ship with calibration agreement, and the manipulation red-team suite passes. | planned |
| R8 | CI integration | A GitHub Action posts a delta table and blocks a PR on a threshold breach. | planned |
| R9 | Trace store and viewer | Two runs of one task are rendered, diffed, and the divergent turn located. | planned |
| R10 | Packaging, operations, and 1.0 | Packaging, install, docs, migration, and a published public result set satisfy the 1.0 gate. | planned |

## First Subject: Robin

Robin, a coding-agent CLI developed in a sibling repository, is the first
subject under test — through `adapter-robin`, subprocess-only, never linked
in-process. Robin's deterministic credential-free synthetic provider
(`robin --print` on a synthetic profile) makes Assay's Robin end-to-end
suite deterministic and free. The adapter pins the tested Robin version and
preview flag spellings and re-verifies when Robin's automation contract
freezes at Robin's R7 gate; until then its conformance tier is
pinned-preview. Assay's own logic is proven one level lower by the in-repo
`adapter-simulated` scripted agent, which requires no Robin at all. A paid
live provider is never used to prove logic a synthetic one can prove.

## Documentation Map

[docs/README.md](docs/README.md) is the index, reading order, and conflict
rules. The full set:

| Document | Contents |
| --- | --- |
| [PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Users, requirement register, CLI semantics, acceptance criteria |
| [BUILD_PLAN.md](docs/BUILD_PLAN.md) | Gates R0–R10, tickets, evidence matrices, traceability |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Package boundaries, interfaces, state machine, event union, errors |
| [METHODOLOGY.md](docs/METHODOLOGY.md) | Statistical definitions, wording contract, power/MDE, judge calibration |
| [TASK_FORMAT.md](docs/TASK_FORMAT.md) | YAML task and suite schemas, inheritance, matrix, migration |
| [AGENT_COMPATIBILITY.md](docs/AGENT_COMPATIBILITY.md) | `assay-adapter/1` contract, conformance suite and tiers |
| [OPERATIONS_TEST_PLAN.md](docs/OPERATIONS_TEST_PLAN.md) | Bootstrap, CI policy, packaging, release mechanics |
| [THREAT_MODEL.md](docs/THREAT_MODEL.md) | Trust boundaries, bounded isolation claim, escape tests |
| [PRIVACY_AND_DATA.md](docs/PRIVACY_AND_DATA.md) | Local-first data posture, redaction, egress, retention |
| [LANDSCAPE.md](docs/LANDSCAPE.md) | Honest analysis of the existing tools named above |
| [MARKETING.md](docs/MARKETING.md) | Positioning, launch assets, gate-tied launch sequencing |
| [GLOSSARY.md](docs/GLOSSARY.md) | Controlled vocabulary |
| [OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Deferred decisions with fail-closed defaults and reopen triggers |
| [decisions/](docs/decisions/) | Accepted ADRs 0001–0014 |

When documents disagree, the precedence order in
[docs/README.md](docs/README.md) controls, ending with the rule that a
marketing claim without an accepted gate behind it is a documentation
defect.

## Contributing

Development follows the gate order in
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md); nothing merges without the
evidence its ticket names. The developer bootstrap lives in
[docs/OPERATIONS_TEST_PLAN.md](docs/OPERATIONS_TEST_PLAN.md), and its first
step — before installing any toolchain — is authenticating the GitHub CLI
with `gh auth login` and verifying with `gh auth status`, because every
repository, branch-protection, Action, and release step depends on it.

Ground rules that bind every contribution:

- Required CI is deterministic and spends zero dollars on providers; no
  live provider call appears in any required check.
- A single run is never a quality claim; comparing surfaces report pass
  rates over n runs with 95% Wilson intervals.
- Planned behavior is labeled planned until its named tests and evidence
  pass; a stub or happy-path unit test is never completion.
- Security claims bind to a named boundary and its escape tests; the
  sandbox shares a kernel with the host and the docs say so.

## License

MIT (license file to be added when the repository is initialized at R0).

Last revised: 2026-08-30.
