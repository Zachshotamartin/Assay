# ADR-0004: OCI Container Sandbox via Docker Engine API

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-SAND-001 through FR-SAND-012,
  FR-BUD-007, FR-RUN-006, NFR-SEC-002, NFR-SEC-007

## Context

Agents under test execute arbitrary tool calls against a fixture workspace,
so R2 cannot be planned without a fixed isolation technology. The sandbox
must run on contributor laptops (macOS and Linux) and in GitHub-hosted
CI, materialize fixtures without exposing the harness checkout, enforce
resource limits, and guarantee cleanup after crashes (FR-SAND-006,
FR-RUN-011). It trades isolation against portability; the losing
dimension must be stated honestly, not papered over.

## Decision

Each task run executes in a dedicated OCI container driven through the
Docker Engine API (Docker Desktop or a rootless Docker/Podman-compatible
socket). Per run: fixture materialized via tar stream into a
container-private workdir volume, `--network none` by default with an
explicit per-task allowlist escape hatch that downgrades the run's
isolation label, read-only root filesystem, tmpfs scratch, CPU/memory/pids
limits, no ambient credentials, harness-side wall-clock timeout, and
labeled containers reaped by `assay gc` on start, on exit, and on signal.
Images are pinned by digest (FR-SAND-011).

## Escape Surface

The isolation claim is bounded and the residual surface is named. The
container shares the host kernel through the container runtime: a kernel
exploit reachable from an unprivileged container escapes the sandbox, and
a compromised kernel or Docker daemon is outside the defended boundary.
The Docker daemon itself is privileged; Assay never mounts the Docker
socket into a task container, because socket access is root-equivalent on
the host. The mount and symlink surface is constrained by construction:
fixtures arrive as tar streams into container-private volumes (never host
bind mounts of the checkout); tar entries with absolute paths, `..`
traversal, or symlinks escaping the workdir are rejected before
materialization; concurrent sandboxes share no writable mounts
(FR-SAND-012). The network namespace is empty by default; a task-declared
allowlist is the only egress, visible in the isolation label on every
report. Escape-attempt tests across filesystem, network, process,
resource-exhaustion, and fixture-poisoning vectors run in CI
(FR-SAND-007); THREAT_MODEL.md names each one. Firecracker and nsjail
would shrink this surface with a guest kernel or seccomp-tight namespaces,
but both lost on portability: each is Linux-only, and killing the macOS
development story would gut local-first adoption for residual risk the
threat model does not require closing.

## Alternatives Considered

- Firecracker microVMs: rejected because they require Linux with KVM,
  eliminating macOS development; a stronger boundary does not offset
  losing the primary developer platform.
- nsjail: rejected because it is Linux-only with no macOS answer, and its
  namespace configuration burden lands on every task author.
- Language-level sandboxing (Node vm, workers): rejected because it is not
  a security boundary; in-process escape from a JavaScript realm is trivial.

## Consequences

One sandbox implementation covers macOS, Linux, and CI; cleanup is testable
via kill-and-reap fixtures. Sandbox unavailability is a stable error, never
silent host fallback (FR-SAND-009); host exec exists only behind
`--unsafe-host-exec` with a persistent banner (FR-SAND-010). The cost is
the bounded isolation claim above. Revisit if Assay targets hostile
multi-tenant execution (a new ADR) or a portable microVM supports macOS.
