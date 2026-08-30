# ADR-0011: Local Read-Only React Viewer

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TRACE-003, FR-TRACE-004,
  FR-TRACE-005, FR-TRACE-008, FR-TRAJ-011, NFR-SEC-005, NFR-COST-006,
  NFR-PRIV-006

## Context

A blocked PR is only actionable if the engineer can see why: which turn
diverged, which tool call looped, where the budget burned. Terminal
reports summarize; they cannot render a 200-turn trajectory diff at
useful density. The viewer technology must be decided now because it
constrains the trace-store query surface (FR-TRACE-002), the turn
alignment keys that make diffing possible (FR-TRAJ-011), and the R9 gate.
It also inherits two hard boundaries from ADR-0002: no hosted service,
and no telemetry (NFR-PRIV-006).

## Decision

`assay view` starts a local-only, loopback-bound, token-authenticated,
read-only HTTP server over the trace store, serving a React + Vite SPA
bundled into the CLI at build time — no CDN, no telemetry, no external
requests of any kind. The server exposes no mutation endpoint
(FR-TRACE-008). The diff view aligns two runs of the same task
turn-by-turn using the FR-TRAJ-011 alignment keys and marks the first
divergent turn. The per-session token and loopback binding satisfy
NFR-SEC-005; a request without the token is rejected regardless of
origin.

## Alternatives Considered

- Electron app: rejected for distribution weight — a hundred-megabyte
  binary with its own update channel and platform-signing burden, to
  render pages a browser the user already has renders identically from a
  local server.
- Terminal-only TUI: rejected because it cannot render trajectory diffs
  at useful density; a side-by-side two-run comparison with per-turn tool
  arguments, token counts, and divergence marking exceeds what a
  character grid can legibly hold, and the diff view is the point of R9.
- Hosted viewer: rejected as out of scope per ADR-0002 — it requires the
  multi-tenant backend that 1.0 explicitly excludes, and it would move
  redacted-but-sensitive traces off the user's machine by default.
- Static HTML report generation only: rejected because comparison
  browsing is interactive — choosing which two runs to diff, expanding
  turns, filtering by task — and pre-rendering every pairwise diff of a
  store is combinatorially wasteful where a query-backed SPA is not.

## Consequences

The viewer ships inside the CLI with zero install steps beyond Assay
itself, works offline, and its read-only server makes the security review
surface small: one bound interface, one token check, no writes. The
NFR-COST-006 target (200-turn trajectory rendered p95 under one second
from the local store) is testable against the same server CI uses.

The costs: a bundled SPA enlarges the published package and pins a
frontend toolchain (React, Vite) to the harness release cycle; frontend
dependency updates go through the same lockfile review gate as everything
else (NFR-SEC-006). The viewer reads the store schema directly, so every
store migration under ADR-0008 must keep the viewer queries in the
migration test matrix. Revisit at R9 if the diff view's density targets
prove unreachable in the DOM for very long trajectories — a
virtualized-rendering rework would stay within this ADR, but any move
off the local-server model is a new ADR.
