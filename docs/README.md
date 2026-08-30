# Assay Documentation Index

Assay is an evaluation harness for coding and tool-using agents that treats
evals as a CI gate rather than a dashboard. Three claims distinguish it, and
they are always stated together: it scores trajectories — the full turn-by-turn
record of model requests, tool calls, and results — not just final answers; it
enforces cost and latency budgets as blocking pass/fail checks; and it treats
stochastic comparison as a statistics problem, refusing to call a difference a
regression without a significance test, confidence intervals, and stated
power.

> Assay is under implementation. Gate R0 code and CI evidence exist on an
> open pull request, but R0 is not accepted because required private-repository
> branch protection and review controls are unavailable on the current GitHub
> plan. No later product gate is accepted.

The root [README](../README.md) is the quick orientation and current
implementation snapshot. It states the honest status, the planned command
surface, and the gate table. This index defines the reading order and the
rules that govern conflicts between documents.

## Reading Order

Read these documents first and in this order:

1. [Product requirements](PRODUCT_REQUIREMENTS.md) defines Assay's users,
   the functional and non-functional requirement register, user-visible CLI
   semantics, exit codes, configuration precedence, and the acceptance
   criteria each release gate must satisfy. It is the source of truth for
   what Assay must do and how success is judged.

2. [Build plan](BUILD_PLAN.md) defines implementation order as eleven gates
   R0–R10, their dependency edges, per-gate tickets with definitions of
   done, test-driven evidence matrices, and the requirement-to-evidence
   traceability matrix. It controls what gets built next and what evidence
   unlocks each status change.

3. [Architecture](ARCHITECTURE.md) defines the monorepo package boundaries,
   the canonical TypeScript interfaces, the run lifecycle state machine, the
   versioned event union, the error taxonomy, and the trust boundary between
   the harness and the subject agent, at implementation depth.

4. [Methodology](METHODOLOGY.md) defines the statistical machinery: Wilson
   score intervals, Newcombe hybrid delta intervals, the Boschloo exact test
   with its Fisher fallback, stratified paired-by-task bootstrap, BH FDR
   control, power and MDE tables, flake classification, the wording
   contract, and the judge calibration and isolation requirements.

5. [Task format](TASK_FORMAT.md) defines the declarative YAML task and
   suite schemas, JSON Schema validation, `extends` single-parent
   inheritance, `matrix` parameterization, fixture references, assertion
   specifications, budget declarations, and format versioning and migration.

6. [Agent compatibility](AGENT_COMPATIBILITY.md) defines the versioned
   `assay-adapter/1` JSONL subprocess contract: handshake, event schema,
   usage and cost fields, termination, the conformance suite, conformance
   tiers, the black-box tier's stated measurement limits, and the simulated
   and Robin reference adapters.

7. [Operations and test plan](OPERATIONS_TEST_PLAN.md) defines developer
   bootstrap (step 1 is GitHub CLI authentication), the deterministic
   zero-dollar CI policy, fixture governance, packaging, clean-machine
   verification, migration testing, diagnostics, and release mechanics.

8. [Threat model](THREAT_MODEL.md) defines assets, actors, trust
   boundaries, abuse cases, the bounded sandbox isolation claim with its
   named escape tests, judge-manipulation defenses, and the evidence each
   security claim requires before it may be stated as more than planned.

9. [Privacy and data](PRIVACY_AND_DATA.md) defines the local-first data
   posture, capture-boundary redaction, per-provider egress documentation,
   export bundles, deletion, retention defaults, and the absence of
   telemetry in 1.0.

10. [Landscape](LANDSCAPE.md) describes promptfoo, Braintrust, LangSmith,
    OpenAI Evals, and inspect-ai honestly and accurately, and states the
    narrow claim Assay defends against that field. It is descriptive, not
    normative.

11. [Marketing](MARKETING.md) defines the positioning statement, audience
    segments, messaging pillars, launch assets, channel plan, and
    gate-tied launch sequencing. Its claims are subordinate to gate
    evidence; the claim audit is a release gate ticket in R10.

12. [Glossary](GLOSSARY.md) fixes the controlled vocabulary. When another
    document appears to conflict with a definition there, fix the conflict
    rather than redefining the term locally.

13. [Open questions](OPEN_QUESTIONS.md) registers deferred decisions, each
    with a fail-closed default position and an explicit reopen trigger.
    Nothing in that register may be implemented ahead of its trigger.

14. [Decision records](decisions/) contain the accepted ADRs, ADR-0001
    through ADR-0014, which fix the toolchain, name and scope boundary,
    task format, sandbox technology, adapter contract, statistical method,
    judge policy, trace storage, cost accounting, redaction, and viewer
    stack, deterministic hashing of fractional task values, ownership of
    runner orchestration, and the reconciled pre-publication adapter v1 wire
    contract. Reversals become new ADRs.

## Conflict and Status Rules

When documents disagree:

1. an accepted ADR controls the decision it records;
2. `PRODUCT_REQUIREMENTS.md` controls user-visible semantics and acceptance;
3. `METHODOLOGY.md` controls statistical definitions, wording, and validity;
4. `BUILD_PLAN.md` controls implementation order and gates;
5. `ARCHITECTURE.md` controls component boundaries and interfaces;
6. `TASK_FORMAT.md` controls the task schema where not in conflict with
   items 1–5;
7. `AGENT_COMPATIBILITY.md` controls adapter conformance details;
8. `OPERATIONS_TEST_PLAN.md` controls test, evidence, packaging, and release
   mechanics;
9. `THREAT_MODEL.md` and `PRIVACY_AND_DATA.md` control the evidence required
   behind security and privacy claims;
10. implemented code and passing tests control claims about what works today;
11. `LANDSCAPE.md` and `MARKETING.md` are descriptive, not normative;
    marketing claims are subordinate to gate evidence, and a marketing claim
    without an accepted gate behind it is a documentation defect.

## Status Vocabulary

Every claim in these documents carries one of four statuses. **Accepted**
means implemented on mainline and backed by its named automated gate. **In
progress** means present on a branch and never a release claim. **Planned**
means specified, not implemented. **Deferred** means outside the named phase
and forbidden as completion evidence. A package, type, stub, or happy-path
unit test is never completion. Today every gate is planned.

## Requirements and Evidence

Requirements carry stable identifiers (`FR-TASK`, `FR-RUN`, `FR-ASSERT`,
`FR-TRAJ`, `FR-BUD`, `FR-STAT`, `FR-JUDGE`, `FR-CI`, `FR-TRACE`,
`FR-SAND`, `FR-ADAPT`, and the `NFR-*` namespaces) defined in
PRODUCT_REQUIREMENTS.md. Each requirement is owned by exactly one gate in
BUILD_PLAN.md — the gate whose acceptance evidence terminally proves it —
and the traceability matrix in BUILD_PLAN.md binds every identifier to that
owner and its evidence. A requirement is satisfied when its owner gate's
named evidence is accepted, and never before.

## Documentation Rules

Documentation must follow these rules:

- Label planned behavior as planned until its named tests and evidence pass.
- Never promote a single run into a quality claim; every comparing surface
  reports pass rates over n runs with confidence intervals.
- Never state a judged claim without its calibration data: rubric version,
  calibration set, percent agreement, and Cohen's kappa.
- Never present a container as a security claim without the named isolation
  boundary and the escape tests that defend it.
- Record a product or architecture reversal in a new ADR instead of silently
  editing away the earlier decision.
- Describe the current state only with this claim, verbatim: Assay is a
  fully specified, unimplemented evaluation harness. This repository
  currently contains normative planning documents only. No command, gate,
  or measurement described here exists yet.

Last revised: 2026-08-30.
