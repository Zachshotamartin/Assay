# ADR-0001: TypeScript on Node.js 22 LTS Toolchain

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: NFR-MAINT-001, NFR-MAINT-006,
  NFR-SEC-006, NFR-DET-001, FR-ASSERT-003, FR-TASK-010

## Context

Assay is at the greenfield planning stage: no package exists, and every
subsequent specification (task format, adapter contract, checker execution,
viewer stack) depends on the implementation language. The language decision
must be fixed before any interface in ARCHITECTURE.md can be written as real
code, because checker functions are user-authored modules, the Robin
reference subject is a Node.js program, and the adapter contract is a JSONL
stream that the harness must parse with first-class tooling. Deferring the
choice would force every other planning document to hedge its interfaces.

## Decision

Assay is written in TypeScript running on Node.js 22 LTS with strict mode
enabled, organized as an npm workspaces monorepo. Dependencies are
exact-pinned with lockfile review per the dependency intake gate
(NFR-SEC-006). Vitest is the test runner, esbuild bundles the CLI, and Ajv
validates JSON Schemas at every boundary. User-authored checker assertions
are TypeScript modules exporting a typed `check` function, loaded in a
restricted worker (FR-ASSERT-003).

## Alternatives Considered

- Python: rejected because it would split the checker and task ecosystem
  from the Robin adapter and the viewer stack. Checker authors targeting a
  TypeScript subject would maintain two toolchains, and the Robin reference
  adapter would cross a language boundary for no measurement benefit.
- Go: rejected because it has a weaker story for user-authored checker
  functions — there is no practical way to load a reviewer-diffable Go
  checker at runtime without shipping a compiler step — and a weaker
  JSON-Schema-first task validation ecosystem than Ajv provides.
- Rust: rejected because the iteration-speed cost is unjustified for an
  I/O-bound orchestrator. Assay's hot paths are subprocess streams, Docker
  API calls, and SQLite writes; none is CPU-bound enough to repay Rust's
  compile-and-borrow overhead during a planning-heavy build.

## Consequences

Every interface in the planning documents can be stated as real TypeScript,
and the Robin adapter and its fixtures interoperate without a language
bridge. Checker authors get editor support and type checking for free.

The costs: Node.js version drift must be managed explicitly — the pinned
LTS line is revisited when Node 22 leaves active LTS support (scheduled
October 2027) or when a required dependency drops it, whichever is earlier.
The statistics package (ADR-0006) must be validated against reference
implementations because the JavaScript numerical ecosystem is thinner than
Python's; the mutation-score gate (NFR-MAINT-002) exists partly to offset
that. If a future workload becomes CPU-bound (large bootstrap resamples at
scale), a native-module escape hatch would require a new ADR.
