# Assay: Open Questions and Deferred Decisions

A forward-looking register of decisions the plan intentionally defers. Each
entry names the question, the fail-closed default position that holds until
the entry is reopened, and the concrete trigger that reopens it. Closing an
entry requires a new ADR under `docs/decisions/` and, where security-relevant,
new threat-model and test coverage. An entry may not be silently implemented
ahead of its trigger; doing so is a documentation and process defect.

## OQ-01 Multi-parent task inheritance

- **Question:** should task `extends` support multiple parents with a merge
  precedence order, instead of the single-parent inheritance ADR-0003 fixes?
- **Default (fail-closed):** single-parent only. Shared fragments are
  expressed through one parent plus `matrix` parameterization.
- **Reopen trigger:** two real suites demonstrably blocked — duplicated
  fields that neither a single parent nor a matrix can express — documented
  with the concrete task files.

## OQ-02 Windows-native sandbox

- **Question:** should the sandbox support Windows-native container or job
  isolation rather than requiring WSL2?
- **Default (fail-closed):** WSL2 only on Windows; the harness reports
  `sandbox_unavailable` with WSL2 guidance and never degrades to host exec.
- **Reopen trigger:** tier-1 demand: a named Windows-native user cohort for
  whom WSL2 is unusable, recorded before any implementation begins.

## OQ-03 Bayesian comparison mode

- **Question:** should an opt-in Bayesian comparison mode complement the
  fixed-N frequentist design of ADR-0006?
- **Default (fail-closed):** fixed-N frequentist only. Prior selection is an
  unauditable knob in a gate that must be contestable.
- **Reopen trigger:** a documented gate dispute that the fixed-N design
  cannot resolve, plus an accepted ADR defining priors, reporting, and how a
  posterior threshold is contested in a blocked-PR dispute.

## OQ-04 Hosted result sharing

- **Question:** should Assay offer a hosted service for sharing suite
  results and comparison reports across an organization?
- **Default (fail-closed):** local trace store plus explicit export bundles
  only, per the ADR-0002 scope boundary; no hosted multi-tenant backend.
- **Reopen trigger:** an explicit product pivot recorded in a new ADR that
  supersedes the ADR-0002 boundary, with its own threat model.

## OQ-05 Encryption-at-rest for the trace store

- **Question:** should `.assay/assay.db` and the blob directory be
  encrypted by Assay itself?
- **Default (fail-closed):** the store is written unencrypted; OS-level
  full-disk encryption is assumed and stated in PRIVACY_AND_DATA.md.
  Redaction at the capture boundary remains mandatory regardless.
- **Reopen trigger:** a documented organizational policy demand that
  disk-level encryption does not satisfy, with a key-management design.

## OQ-06 Judge ensembles across model families

- **Question:** should judge assertions support ensembles spanning three or
  more model families instead of a single judge model?
- **Default (fail-closed):** one judge model per assertion, different in
  family from the subject by default, with k = 3 majority voting.
- **Reopen trigger:** the R7 red-team suite demonstrates a manipulation that
  defeats every available single-family judge while a cross-family ensemble
  detects it.

## OQ-07 MCP-based adapter transport

- **Question:** should the adapter contract support MCP as a transport in
  addition to the JSONL subprocess of ADR-0005?
- **Default (fail-closed):** JSONL subprocess only; agents reachable only
  over other transports run in black-box tier or not at all.
- **Reopen trigger:** two real subject agents that cannot be wrapped as a
  subprocess, each documented with the specific technical blocker.

## OQ-08 Non-coding-domain task packs

- **Question:** should Assay ship task packs for domains beyond coding
  agents, such as research or operations agents?
- **Default (fail-closed):** coding agents only, per the ADR-0002
  positioning boundary; no non-coding fixtures enter the repo.
- **Reopen trigger:** 1.0 shipped through R10, plus recorded demand from
  users running non-coding agents against the harness.

## OQ-09 Mutation-testing scope beyond stats and trajectory

- **Question:** should the ≥ 85% mutation-score gate extend past the
  `stats` and `trajectory` packages to other packages?
- **Default (fail-closed):** those two packages only; other packages rely
  on the standard coverage and evidence gates.
- **Reopen trigger:** an escaped-defect postmortem showing a bug in another
  package that mutation testing would have caught.

## OQ-10 Trace-store size caps and auto-pruning

- **Question:** should the trace store enforce size caps with automatic
  pruning of old runs?
- **Default (fail-closed):** keep everything locally; reclamation happens
  only through explicit `assay gc` and `assay delete`.
- **Reopen trigger:** documented user pain with a store exceeding 10 GB
  where manual deletion is shown to be insufficient.

Review this register at every gate boundary. Closing any entry follows the
conflict rules in [docs/README.md](README.md): the closing ADR controls the
decision it records, and every downstream document is updated in the same
change.

Last revised: 2026-08-30.
