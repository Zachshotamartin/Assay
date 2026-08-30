# ADR-0010: Secret Redaction at the Capture Boundary

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TRAJ-007, NFR-SEC-001, NFR-PRIV-002,
  NFR-PRIV-004, NFR-SEC-004

## Context

Assay records everything: model requests, tool output, environment
snapshots, diagnostics. That is the product — and also the hazard, because
agents under test handle BYOK provider keys and operate in workspaces
where credentials can appear in tool output. A trace store that ever holds
a secret converts an evaluation artifact into an exfiltration target, and
exported bundles (FR-TRACE-007) would carry the secret out of the machine.
The redaction point in the pipeline must be fixed before R4's trajectory
capture can be specified, because it determines whether redaction is a
property of the capture path or a cleanup job racing against persistence.

## Decision

Redaction happens at the capture boundary, before any byte is persisted or
leaves the process. Two detectors run on every adapter event, tool output,
env snapshot, and diagnostic: a versioned pattern ruleset (provider key
shapes, PEM blocks, JWTs, cloud credential formats, URL userinfo) and a
Shannon-entropy scanner for high-entropy tokens of 20 or more characters.
Redaction failure is fail-closed: `redaction_failed` blocks persistence of
that record and fails the run as an infrastructure error, never a task
failure. Evidence is a planted-credential corpus exercised in CI — raw,
split across frames, base64-encoded, URL-embedded, inside tool output,
and inside trajectory arguments — with zero tolerated leaks.

## Alternatives Considered

- Post-hoc scrubbing of stored traces: rejected because it creates a
  window in which secrets are on disk — visible to crash dumps, backups,
  file-watching tools, and any process that reads the store between write
  and scrub. A crash inside the window persists the secret indefinitely,
  and no scrub schedule closes a window whose existence is the flaw.
- ML-based secret detection: rejected because its false negatives are
  unauditable. A pattern ruleset can be reviewed line by line and its
  misses reproduced and fixed with a new rule version; a model's miss
  cannot be explained, versioned, or proven fixed, which makes the
  NFR-SEC-001 planted-corpus evidence claim untestable in the direction
  that matters.
- Redacting only known credential env vars: rejected because secrets
  arrive through channels no allowlist anticipates — tool output reading
  a `.env` file, a provider echoing a key in an error message — and the
  planted corpus exists precisely because enumeration fails.

## Consequences

Every persisted byte has passed redaction, so the store, reports, exports,
and diagnostics bundles (NFR-PRIV-004) inherit the guarantee from one
choke point instead of each re-implementing it. The ruleset version is
recorded per run, so a later rule improvement identifies which historical
runs predate it.

The costs: the entropy scanner will redact some legitimate high-entropy
strings (content hashes, random test data), and tasks whose assertions
depend on such strings must mark them via the documented fixture
annotation rather than weakening the scanner. Fail-closed means a
redaction bug halts runs instead of leaking — accepted deliberately. The
ruleset must be revisited on every new supported provider (new key
shapes) and re-audited against the corpus at each release gate from R4
onward; extending detection beyond patterns plus entropy would be a new
ADR carrying its own auditability argument.
