# ADR-0012: Tagged Task Content Hashing

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TASK-005, FR-TASK-006, FR-RUN-007,
  NFR-DET-004

## Context

R0's canonical JSON encoder deliberately accepts only exactly representable
integers. That rule prevents platform-dependent numeric serialization in
persisted records. The task and suite formats also deliberately permit finite
fractional values such as CPU shares, dollar limits, statistical thresholds,
and matrix values. R1 must compute a canonical content hash over the fully
resolved task, but the planning set did not define how a valid fractional
task value crosses the integer-only encoder boundary.

Changing the canonical JSON encoder to accept fractions would weaken the
already-frozen R0 byte contract. Removing fractional task values would break
the published task schema. Hashing source YAML would make semantically equal
documents differ because of comments, scalar spelling, or key order.

## Decision

Before canonical serialization for a task content hash, Assay maps every
parsed value into a fully type-tagged tree:

- null becomes `{ "type": "null" }`;
- a boolean or string becomes an object carrying its explicit type and value;
- every finite number becomes `{ "type": "number", "value": <text> }`,
  where `<text>` is the ECMAScript shortest round-trippable numeric spelling
  and negative zero is normalized to `"0"`;
- an array becomes `{ "type": "array", "value": [...] }` with order
  preserved; and
- an object becomes `{ "type": "object", "value": {...} }` recursively.

The whole tree—not only fractional leaves—is tagged, so no user-authored
object can collide with an encoded scalar. Assay serializes the tree with the
R0 canonical JSON encoder, hashes the UTF-8 bytes with SHA-256, and emits the
lowercase hexadecimal digest. Non-finite values, cycles, and non-plain
objects remain invalid. Numerically equal parsed values such as `1` and
`1.0` intentionally have the same task content hash.

## Alternatives Considered

- Permit fractions in the R0 canonical encoder: rejected because it reverses
  the frozen persisted-record contract and expands its cross-platform number
  formatting surface.
- Hash the original YAML bytes: rejected because comments, whitespace, key
  order, and equivalent scalar spellings are not task-content changes.
- Encode only fractional leaves as marker objects: rejected because a task
  could contain an ordinary object with the same marker shape, creating a
  structural collision.
- Scale every fraction to one global integer unit: rejected because the task
  schema contains unrelated dimensions with different precision and no
  single normative scale.

## Consequences

Valid fractional task values now participate in deterministic hashes without
changing canonical persisted JSON. The projection is intentionally explicit
and tested for type-collision resistance, key-order stability, numeric
equivalence, and fractional values. A future change to the projection changes
task content hashes and therefore requires a new ADR plus comparison-drift
and migration evidence; old stored hashes are never silently rewritten.

