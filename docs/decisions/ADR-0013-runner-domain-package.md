# ADR-0013: Runner Domain Package

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-RUN-001, FR-RUN-002, FR-RUN-003,
  FR-RUN-005, FR-RUN-006, NFR-MAINT-001, NFR-DET-004

## Context

The architecture makes `apps/cli` the sole composition root and forbids it
from owning business logic. The build plan nevertheless assigns R1's task-run
state machine and orchestration loop, and R2's bounded scheduler, without
naming a domain package that may own them. Placing that behavior in the CLI
would violate the frozen package boundary. Placing it in the adapter, sandbox,
assertion, or store packages would give one replaceable mechanism control over
the other mechanisms it is meant to coordinate.

## Decision

Add `packages/runner` as the domain package that owns run planning, the
task-run lifecycle reducer, sequential orchestration, bounded scheduling,
cancellation and cleanup ordering, and run-level outcome aggregation. It
depends inward on contracts and on the public ports exposed by task-format,
adapter-core, assertions, run-store, redaction, sandbox, budgets, trajectory,
and judge as those gates arrive. It does not instantiate their concrete
implementations.

`apps/cli` remains the only process composition root. It parses argv, installs
signal handlers, constructs concrete dependencies, invokes the runner, maps
the returned result to a documented exit code, and prints through injected
output ports. The runner receives `Clock`, identifier and seed sources,
diagnostic/event sinks, and every I/O capability as explicit dependencies; it
must not read global time, randomness, environment variables, signals, or
stdout.

The runner exposes deterministic reducers and orchestration functions through
its package root. Other domain packages never import the runner. Applications
may import it, and the architecture checker treats every runner-to-domain edge
as explicit rather than as permission for deep imports.

## Alternatives Considered

- Put orchestration in `apps/cli`: rejected because it makes the composition
  root own business logic and prevents the Action or tests from reusing the
  same lifecycle without invoking a CLI process.
- Put orchestration in `packages/run-store`: rejected because storage must not
  decide lifecycle, adapter, assertion, or cleanup policy.
- Put orchestration in `packages/adapter-core`: rejected because an adapter is
  one supervised dependency of a task run and must not control persistence,
  scoring, or sandboxes.
- Leave the owner implicit: rejected because the architecture check cannot
  enforce an unnamed boundary and implementations would choose incompatible
  homes gate by gate.

## Consequences

R1 has a legal home for the reducer and sequential loop, and R2 can extend the
same package with bounded concurrency without moving logic across boundaries.
The CLI stays thin and all runner behavior is testable with deterministic
ports. The package has a deliberately broad coordinating dependency surface;
architecture checks and public-root imports constrain that surface, while
concrete construction remains application-only.
