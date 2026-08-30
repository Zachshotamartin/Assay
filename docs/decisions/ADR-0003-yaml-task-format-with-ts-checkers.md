# ADR-0003: Declarative YAML Task Format with TypeScript Checkers

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TASK-001 through FR-TASK-012,
  FR-ASSERT-001, FR-ASSERT-003, FR-ASSERT-004, NFR-MAINT-005

## Context

The task definition format is the primary user-facing contract: every suite
a team writes, reviews, and diffs in pull requests uses it. It must be
decided before R1 planning can specify the loader, validator, or runner.
The format has to satisfy competing demands: reviewable in a PR by someone
who did not write it, machine-validated before any run, expressive enough
for programmatic assertions on trajectories, and safe to parse — loading a
task must never execute code (FR-TASK-003). No single representation
satisfies all four, which forces a split between declarative structure and
programmatic escape hatch.

## Decision

Tasks and suites are declarative YAML files validated by published JSON
Schemas before any run. Programmatic assertions are referenced as
TypeScript module paths exporting a typed `check` function, executed in a
restricted worker with time and memory limits (FR-ASSERT-003). Tasks
support `extends` single-parent inheritance with documented per-field merge
rules and cycle rejection (FR-TASK-004), and `matrix` parameterization
expanded to concrete task instances with deterministic ids at load time
(FR-TASK-005). Every task carries `format_version`; unknown majors are
rejected with a stable error (FR-TASK-007).

## Alternatives Considered

- Pure-code task definitions (tasks as TypeScript programs): rejected
  because they are not reviewable or diffable by non-authors — a reviewer
  cannot approve a task without tracing arbitrary code — and because
  executing code at load time violates FR-TASK-003 and makes `assay
  validate` unsound.
- A custom typed DSL: rejected for parser and tooling cost with no editor
  support. Every hour spent on a grammar, formatter, and language server is
  an hour not spent on the harness, and users would learn a syntax that
  exists nowhere else.
- JSON: rejected because it has no comments — task intent lives in
  comments during review — and poor review ergonomics: no trailing commas,
  noisy quoting, and multi-line prompts become escaped strings that are
  unreadable in a diff.

## Consequences

Suites live in version control as plain text; a PR that changes a task
shows exactly what changed, and FR-STAT-010's content-hash pairing has a
canonical byte representation to hash. The checker worker boundary means a
misbehaving checker is an assertion error, never a harness crash
(FR-ASSERT-004).

The costs: two artifact kinds (YAML plus checker modules) must version
together, and YAML's implicit typing requires a strict schema-first parse
profile to avoid the classic footguns (`no` parsed as false). The
inheritance merge rules are a permanent documentation liability. This ADR
is revisited when format migrations first ship (FR-TASK-011, owned by
R10): if `extends` plus `matrix` proves insufficient for real suites, the
extension is a new format major and a new ADR, never a silent loader
change.
