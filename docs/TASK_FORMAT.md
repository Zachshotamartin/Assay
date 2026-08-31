# Assay Task Format

Document status: normative specification of the Assay task, suite, rubric,
matrix, and checker file formats. R1 has branch-local implementation and local
evidence for these formats, but it is not accepted; later behavior is planned.

Last revised: 2026-08-30

> Assay is under implementation. Gates R0 and R1 have code and local evidence
> on gate branches, but neither is accepted: R0 is blocked by unavailable
> private-repository branch protection and review controls on the current GitHub
> plan, and R1 depends on accepted R0. No product gate is accepted.

This document controls the task schema. Where it conflicts with an accepted
ADR, PRODUCT_REQUIREMENTS.md, METHODOLOGY.md, BUILD_PLAN.md, or
ARCHITECTURE.md, those documents win, in that order. The task format decision
itself is recorded in
[ADR-0003](decisions/ADR-0003-yaml-task-format-with-ts-checkers.md).

## 1. Format overview and design goals

An Assay task is a declarative YAML document. It describes what to run, in
what sandbox, against which fixture, and what must be true afterward. It never
contains executable logic itself; programmatic checks are referenced as
TypeScript checker modules that run later, in a restricted worker, during
assertion evaluation — never at parse time.

The format serves five goals, fixed by ADR-0003:

1. **Reviewable and diffable.** Task and suite files are plain text with
   stable key ordering conventions, so a pull request that changes an eval is
   reviewable the same way a pull request that changes code is. A reviewer
   who has never read Assay source code must be able to read a task file and
   state what it asserts (FR-TASK-003).
2. **No execution at parse time.** Loading, validating, inheriting, and
   matrix-expanding a task performs no I/O beyond reading referenced files
   inside the repository, spawns no process, opens no socket, and evaluates
   no user code. `assay validate` is safe to run on an untrusted branch
   (FR-TASK-010).
3. **Schema-validated before anything runs.** Every file kind has a published
   JSON Schema. Validation runs with Ajv in strict mode; unknown fields are
   rejected, not ignored (FR-TASK-001, FR-TASK-002).
4. **Versioned.** Every task, suite, rubric, and matrix file carries
   `format_version`. Loaders reject unknown majors with a stable error and
   never silently rewrite a file (FR-TASK-007, FR-TASK-011).
5. **Deterministic loading.** The same set of files always resolves to the
   same set of concrete task instances in the same order, on every platform.
   Inheritance merge, matrix expansion, and suite selection are pure
   functions of file content (FR-TASK-005, FR-TASK-006).

ADR-0003 rejected the alternatives deliberately: pure-code task definitions
are not reviewable or diffable by non-authors; a custom typed DSL costs a
parser and editor tooling Assay does not need; JSON forbids comments and
reviews poorly. YAML with a strict schema and a narrow escape hatch into
typed TypeScript checkers keeps the declarative surface small and the
programmable surface contained.

YAML is parsed in safe mode: the core schema only, no custom tags, no
language-native object construction. Anchors and aliases are permitted
because they resolve to plain data. Duplicate mapping keys are a parse error,
never last-wins.

## 2. File kinds, naming, and discovery

The format defines five file kinds. Kind is determined by filename suffix,
never by content sniffing. A file whose suffix and content shape disagree
fails validation under the category for its suffix-declared kind.

| Kind | Suffix | Purpose |
| --- | --- | --- |
| Task | `*.task.yaml` | One task definition (or an abstract parent) |
| Suite | `*.suite.yaml` | Task selection, variants, comparison config |
| Rubric | `*.rubric.yaml` | Judge rubric plus calibration reference |
| Matrix | `*.matrix.yaml` | Parameterization of one base task |
| Checker | `*.checker.ts` | Programmatic assertion module (TypeScript) |

Naming rules:

- The basename before the kind suffix must match
  `^[a-z0-9][a-z0-9-]{0,62}$`. Violation is `task_invalid` (or the
  kind-appropriate category) with a stable message naming the file.
- A task file's basename should equal its `id`; the loader emits a warning,
  not an error, when they differ, because `id` is the identity and the
  filename is not (FR-TASK-012).
- Checker modules are named `<name>.checker.ts` and live beside the task
  files that reference them.

Discovery rules:

- There is no implicit global task registry. A suite names its tasks through
  `include` paths and globs (§5). A matrix names its base task explicitly
  (§6). A task names its checker modules, prompt files, expected patches,
  schemas, and rubrics explicitly, always by path relative to the referencing
  file.
- All references must resolve to files inside the project root after symlink
  resolution. A reference that escapes the project root (via `..` or a
  symlink) is `task_invalid` / `suite_invalid` for the referencing file.
- `assay validate` with explicit paths validates exactly those files plus
  their transitive references. `assay validate` with no arguments walks the
  project root for the four YAML kinds, excluding `.assay/`, `.git/`, and
  `node_modules/`, and validates each together with its references.
- Checker modules are never discovered independently. An unreferenced
  `*.checker.ts` file is ignored by validation and reported by
  `assay validate --report-unreferenced` as informational output.

Glob semantics (used by suite `include` and by `assay validate` arguments):
`*` matches within one path segment, `**` matches across segments, character
classes are not supported. Glob expansion results are sorted by UTF-8 byte
order before use, so downstream ordering never depends on filesystem
enumeration order.

## 3. Task schema

A complete annotated skeleton. Every field is specified individually below.

```yaml
format_version: "1.0"
id: fix-cache-eviction
title: Fix the LRU cache eviction off-by-one
description: >
  The fixture repository has a failing test caused by an off-by-one in
  eviction order. The agent must locate and fix it.
tags: [bugfix, typescript]
extends: ../shared/base-node.task.yaml
fixture:
  path: ../../fixtures/repos/lru-cache-bug
  git_init: true
prompt:
  file: ./fix-cache-eviction.prompt.md
toolset:
  catalog: robin/1
  allow: [read_file, write_file, run_command]
  deny: []
sandbox:
  image: ghcr.io/assay-fixtures/node22@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  network: none
  cpu: 1
  memory_mb: 1024
  pids: 256
  disk_mb: 1024
  timeout_ms: 300000
  env:
    CI: "true"
  workdir: /workspace
assertions:
  - type: tests_pass
    command: ["npm", "test"]
budgets:
  tokens: { limit: 60000, aggregate: median, scope: task }
run_policy:
  n: 10
  seed: 42
  seed_strategy: derived
```

Unknown top-level or nested fields are rejected with `task_invalid`
(FR-TASK-002). All violations below are `task_invalid` unless a different
category is named.

### 3.1 `format_version`

- Type: string. Required. No default.
- Validation: must match `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (two-component
  semver-style). The major component must equal `1`. A minor component newer
  than the loader supports is rejected — strict unknown-field rejection makes
  forward reading unsafe, so the loader refuses rather than guesses.
- On violation: `task_invalid` with stable code
  `task_invalid/format-version-unsupported`, naming the file, the found
  version, and the supported range (FR-TASK-007).
- Not inheritable via `extends`; every file declares its own.

### 3.2 `id`

- Type: string. Required. No default.
- Validation: must match `^[a-z0-9][a-z0-9-]{1,62}$` — lowercase
  alphanumerics and hyphens, 2–63 characters, starting with an alphanumeric.
  This charset is safe as a filesystem path segment, a SQLite key, and a
  container label, with no escaping anywhere (FR-TASK-012).
- Uniqueness: unique within a suite's resolved task set, including matrix
  instances. Duplicates are detected at suite load and reported as
  `suite_invalid`, naming both defining files.
- Stability: `id` is the task's identity across renames and moves. Run
  history, comparisons, and flake classification key on it. Changing an `id`
  is semantically creating a new task; comparisons refuse to pair different
  ids (FR-STAT-010 covers the content-hash side).
- Not inheritable via `extends`; a child must declare its own `id`.

### 3.3 `title`

- Type: string. Required for concrete tasks. No default.
- Validation: non-empty, single line (no `\n`), at most 120 characters after
  trimming. Used verbatim in reports and the viewer.

### 3.4 `description`

- Type: string. Optional. Default: empty.
- Validation: at most 4096 characters. Multiline allowed. Purely
  documentary; never enters the agent prompt or the judge prompt.

### 3.5 `tags`

- Type: list of strings. Optional. Default: `[]`.
- Validation: each tag matches `^[a-z0-9][a-z0-9-]{0,31}$`; duplicates within
  the list are rejected. Tags drive suite selection (§5.3) and report
  grouping; they never change execution behavior.

### 3.6 `abstract`

- Type: boolean. Optional. Default: `false`.
- Semantics: an abstract task exists only to be extended. It may omit fields
  that are required of concrete tasks (`title`, `fixture`, `prompt`,
  `toolset`, `sandbox`, `assertions`). It is excluded from suite selection;
  a suite `include` glob that matches an abstract task silently skips it, and
  an `include` path that names one directly is `suite_invalid`.
- A concrete task (the default) is validated in full against the resolved,
  post-inheritance document.

### 3.7 `extends`

- Type: string (single relative path to a parent `*.task.yaml`). Optional.
  No default.
- Single-parent only. Multi-parent inheritance is deferred (§10.1). A list
  value is `task_invalid`.
- The parent must exist, parse, and carry the same `format_version` major.
  A missing parent is `task_invalid` with code
  `task_invalid/extends-unresolved`.
- Chains resolve transitively. The chain length limit is 8; a longer chain is
  `task_invalid`. A cycle (a file reachable from itself through `extends`)
  is `task_invalid` with code `task_invalid/extends-cycle`, listing the
  cycle's member paths in traversal order (FR-TASK-004).

Merge rules, applied parent-first at every level of the document:

| Value shape | Rule |
| --- | --- |
| Scalar (string, number, boolean) | Child overrides parent |
| List | Child **replaces** parent by default |
| List under a `+append:`-prefixed key | Child appends to parent's list |
| Mapping | Deep merge, recursing with these same rules |
| `assertions` | Child **always replaces**; never merged, never appendable |

The `+append:` opt-in is spelled as a literal key prefix. For example,
`+append:tags: [slow]` appends `slow` to the inherited `tags` list, preserving
parent order then child order, then rejecting duplicates as usual. The prefix
is valid only where the schema declares a list-valued field; `+append:` on a
scalar or mapping key, on `assertions`, or in a file with no `extends` is
`task_invalid`.

`assertions` always replace because assertion semantics depend on total order
(§4.1); a child that inherits half an assertion list cannot review what it
asserts. A child that wants the parent's assertions restates them.

`format_version` and `id` are never inherited (§3.1, §3.2). Relative paths in
an inherited field remain relative to the file that declared them — the
parent's `fixture.path` resolves against the parent's directory, not the
child's.

### 3.8 `fixture`

- Type: mapping. Required for concrete tasks. No default.
- Exactly one of `path` or `archive` must be present; zero or both is
  `task_invalid`.

`path` form — an in-repo directory:

```yaml
fixture:
  path: ../../fixtures/repos/lru-cache-bug
  git_init: true
```

- `path` (string, required): relative path from the task file to a directory
  inside the project root. A missing or non-directory target is
  `fixture_unavailable`. Escaping the project root is `task_invalid`.

`archive` form — a content-addressed archive:

```yaml
fixture:
  archive:
    ref: fixtures/archives/lru-cache-bug.tar
    sha256: "3b1f04a67cbbc63e5cd2ff1f2f0f60f4a08737d64f22dbf972ea0d43e2bd0d10"
  git_init: true
```

- `archive.ref` (string, required): relative path to a tar archive inside
  the project root. No URL forms exist; remote fixture registries are
  deferred (§10.2), and no network fetch ever happens at load or validate
  time (FR-TASK-008).
- `archive.sha256` (string, required): 64 lowercase hex characters. The
  archive's SHA-256 is verified before materialization and by
  `assay validate`; a mismatch is `fixture_hash_mismatch` and fails closed
  (NFR-SEC-007). A missing archive file is `fixture_unavailable`.
- `git_init` (boolean, optional, default `false`): when true, materialization
  initializes a Git repository in the workspace with a fixed author identity,
  fixed committer identity, and fixed timestamp, and commits the fixture
  content as the single root commit. This makes `diff_matches` and
  Git-using agents deterministic. The identity and timestamp constants are
  owned by the sandbox package and recorded in the run record.

The container never sees the harness checkout; fixtures reach the sandbox as
a tar stream per ADR-0004 (FR-SAND-002).

### 3.9 `prompt`

- Type: string, or mapping with `file`. Required for concrete tasks.
- Inline form: a non-empty string; this exact text is the agent's initial
  prompt. Leading/trailing whitespace is preserved.
- File form: `prompt: { file: ./name.prompt.md }` — a relative path to a
  UTF-8 text file at most 256 KiB. A missing file, a file that fails strict
  UTF-8 decoding, or an oversized file is `task_invalid`.
- Empty prompts (empty string or empty file) are `task_invalid`; a task with
  nothing to ask measures nothing.

### 3.10 `toolset`

- Type: mapping. Required for concrete tasks.

```yaml
toolset:
  catalog: robin/1
  allow: [read_file, write_file, run_command]
  deny: [web_fetch]
```

- `catalog` (string, required): the adapter tool-catalog selector,
  `<adapter-id>/<catalog-major>`. The adapter declares its catalog with
  semantic classes (read/write/execute) in its handshake (FR-ADAPT-006);
  trajectory metrics consume those classes (FR-TRAJ-010).
- `allow` (list of strings, optional, default `[]`): tool names the agent may
  use. Empty means the full catalog.
- `deny` (list of strings, optional, default `[]`): tool names removed after
  `allow` is applied. Deny always wins over allow.
- Validation at parse time is shape-only: name charset
  (`^[a-z0-9_]{1,64}$`), duplicates rejected, a name in both lists rejected.
  Whether a name exists in the catalog is checkable only against a live
  adapter handshake, so it is verified at run start, not at validate time —
  validating must not execute anything (FR-TASK-010). An unknown name at run
  start is `adapter_protocol_error` for that run.

### 3.11 `sandbox`

- Type: mapping. Required for concrete tasks. Governs the ADR-0004 container.

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `image` | string | yes | — | OCI ref pinned by digest: must contain `@sha256:` + 64 hex (FR-SAND-011). Tag-only refs are `task_invalid`. |
| `network` | string | no | `none` | `none` or `allowlist` |
| `hosts` | list | iff `network: allowlist` | — | non-empty list of DNS hostnames; no ports, no wildcards, no IP literals in 1.0 |
| `cpu` | number | no | `1` | > 0, ≤ 16 |
| `memory_mb` | integer | no | `1024` | ≥ 64, ≤ 65536 |
| `pids` | integer | no | `256` | ≥ 16, ≤ 4096 |
| `disk_mb` | integer | no | `1024` | ≥ 64, ≤ 65536 |
| `timeout_ms` | integer | no | `300000` | ≥ 1000, ≤ 3600000; harness-side monotonic wall clock (FR-RUN-008) |
| `env` | mapping | no | `{}` | see below |
| `workdir` | string | no | `/workspace` | absolute POSIX path inside the container |

- `network: allowlist` is the explicit escape hatch from ADR-0004. Declaring
  it downgrades the run's isolation label, and every report containing the
  run states the downgrade (FR-SAND-003, FR-TASK-009). Declaring `hosts`
  with `network: none` is `task_invalid`.
- `env` is a name-to-literal-string map and is the complete container
  environment beyond the runtime's minimal defaults — there are no ambient
  credentials and no host passthrough (FR-SAND-004). Names must match
  `^[A-Z][A-Z0-9_]{0,63}$`. Values are scanned by the ADR-0010 redaction
  ruleset at validate time; a value matching a credential pattern is
  `task_invalid` — secrets never belong in task files. Credentialed runs
  resolve secrets at spawn time per NFR-SEC-004, outside the task format.
- Limit breach at runtime is `sandbox_limit_exceeded`; timeout is
  `sandbox_timeout`. Both are run infrastructure outcomes, distinct from
  assertion failure (FR-RUN-003).

### 3.12 `assertions`

- Type: ordered list of assertion mappings. Required for concrete tasks;
  must be non-empty.
- Every entry has a `type` field naming one of the eleven assertion types in
  §4, an optional `name` (string, ≤ 64 chars, unique within the task) used
  in reports, and type-specific fields.
- Ordering is meaningful and layered. See §4.1 for the layering rule and its
  validation (`task_invalid` on violation).

### 3.13 `budgets`

- Type: mapping. Optional. Default: no budgets (nothing cost-gates).

```yaml
budgets:
  tokens: { limit: 60000, aggregate: median, scope: task }
  wall_clock_ms: { limit: 120000, aggregate: p95, scope: task }
  tool_calls: { limit: 40, aggregate: median, scope: task }
  dollars: { limit: 0.50, aggregate: median, scope: task }
```

Each of the four keys (`tokens`, `wall_clock_ms`, `tool_calls`, `dollars`)
is optional and takes:

- `limit` (number, required): > 0. `tokens`, `wall_clock_ms`, and
  `tool_calls` must be integers; `dollars` accepts up to 4 decimal places.
- `aggregate` (string, optional, default `median`): `median` or `p95`. The
  budget compares this statistic across the task's n runs — never a single
  run (FR-BUD-004).
- `scope` (string, optional, default `task`): in a task file, only `task` is
  valid; `scope: suite` here is `task_invalid`. Suite-scoped budgets are
  declared in suite files (§5.5).

Budget breach is a blocking failure with its own exit code (2) and report
row, distinct from assertion failure (FR-BUD-002). Dollar budgets evaluate
against reconciled usage only; an unreconciled run fails the budget closed
per ADR-0009 (FR-BUD-003).

### 3.14 `run_policy`

- Type: mapping. Optional.

| Field | Type | Default | Validation |
| --- | --- | --- | --- |
| `n` | integer | `10` | 1 ≤ n ≤ 100 |
| `seed` | integer | `0` | 0 ≤ seed < 2^32 |
| `seed_strategy` | string | `derived` | `derived` or `fixed` |

- `n` is the default runs-per-task for this task; `assay run -n` overrides
  it. Comparative claims require n ≥ 5 per METHODOLOGY.md; a comparison over
  fewer runs reports "insufficient data" — the task file cannot lower that
  floor.
- `derived` gives run k (zero-based) the seed `seed + k`; `fixed` gives every
  run the same `seed`. Every effective seed is recorded in the run record
  (NFR-DET-002, FR-RUN-007).

### 3.15 `judge`

- Type: mapping. Optional. Required if any assertion has `type: judge`
  (its absence with a judge assertion present is `task_invalid`,
  FR-ASSERT-006).

```yaml
judge:
  rubric: ./review-quality.rubric.yaml
  model: { family_not: subject }
  allow_same_family_judge: false
```

- `rubric` (string, required): relative path to a `*.rubric.yaml` file
  (§4.12). Missing or invalid rubric is `task_invalid`.
- `model` (mapping, optional): a constraint on the judge model. Either
  `family_not: subject` (the default — the judge must be a different model
  family from the subject agent's model, per ADR-0007) or
  `id: <model-id>` to pin an exact judge model.
- `allow_same_family_judge` (boolean, optional, default `false`): permission
  to use a judge from the subject's model family. Effective only when the
  suite also sets it (§5.7) — both must be true, and every report that
  includes the judged result carries the same-family flag (FR-JUDGE-005).
  A task setting `true` under a suite setting `false` is `suite_invalid` at
  suite load, so the disagreement is visible where the suite is reviewed.

### 3.16 `trajectory_expectations`

- Type: mapping. Optional. Declares the ground truth that trajectory metrics
  (§4.10) compare against. Without it, metrics that need declarations
  (`tool_selection_correctness`, `ordering_violations`) are unavailable, and
  a trajectory assertion naming them is `task_invalid`.

```yaml
trajectory_expectations:
  expected_tools: [read_file, write_file, run_command]
  ordering:
    - { first: read_file, then: write_file }
  read_before_write: true
```

- `expected_tools` (list of tool names, optional): the tool set a correct
  solution uses. `tool_selection_correctness` is computed against it.
- `ordering` (list, optional): each entry `{ first: A, then: B }` requires
  that every call of tool `B` be preceded by at least one call of tool `A`
  in the same trajectory. `A` and `B` must differ. Each violated constraint
  instance increments `ordering_violations`.
- `read_before_write` (boolean, optional, default `true`): when true, every
  write-class tool call targeting a path must be preceded by a read-class
  call for that path, using the semantic classes from the adapter tool
  catalog (FR-TRAJ-010). Violations feed `read_before_write_violations`.

Names here are shape-checked at validate time like `toolset` names (§3.10)
and resolved against the live catalog at run start.

## 4. Assertion types

### 4.1 Layering and evaluation order

Assertions belong to exactly one of three layers:

| Layer | Types | Cost |
| --- | --- | --- |
| deterministic | `exit_code`, `tests_pass`, `file_exists`, `file_absent`, `file_contains`, `json_schema`, `diff_matches`, `command_output`, `trajectory` | cheap, hermetic |
| checker | `checker` | user code in a worker |
| judge | `judge` | provider call, paid |

The layering rule (FR-ASSERT-002): within the `assertions` list, every
deterministic assertion must precede every checker assertion, and every
checker assertion must precede every judge assertion. A list violating this
order is `task_invalid` with code `task_invalid/assertion-layer-order`,
naming the first out-of-place entry. Within a layer, declared order is
evaluation order.

Evaluation semantics common to all types:

- All assertions evaluate against the workspace snapshot taken from the
  container after agent exit and against the captured trajectory — never
  against harness host state (FR-ASSERT-008, FR-SAND-008).
- Every assertion runs; a failure does not short-circuit later assertions in
  the same or earlier layers. Judge assertions are the exception: if any
  earlier assertion errored (not failed), judges are skipped to avoid paying
  for a verdict on a broken run, and the skip is recorded.
- Every result records type, target, observed value, expectation, verdict
  (`pass | fail | error`), and duration (FR-ASSERT-005). `error` means the
  assertion could not be evaluated (`assertion_error` category) and is never
  scored as task failure (FR-ASSERT-004, FR-RUN-003).
- The task's outcome is `pass` only if every non-advisory assertion passes.

### 4.2 `exit_code`

Asserts on the exit status of the agent subprocess as reported by the
adapter's termination event.

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `equals` | integer | no | `0` | 0 ≤ value ≤ 255 |

Edge cases: an agent terminated by signal N observes exit code `128 + N` and
compares normally. If the adapter never emits a termination status (protocol
violation), the assertion result is `error`, and the run is separately
classified `adapter_protocol_error`.

```yaml
- type: exit_code
  equals: 0
```

### 4.3 `tests_pass`

Runs a declared command inside the sandbox against the post-agent workspace
and passes iff the exit status is zero. It parses the exit status only; it
never inspects logs heuristically (FR-ASSERT-010).

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `command` | list of strings | yes | — | argv array, non-empty; a plain string is `task_invalid` (no shell interpretation exists) |
| `cwd` | string | no | sandbox `workdir` | workspace-relative or absolute inside the container |
| `timeout_ms` | integer | no | `120000` | ≥ 1000, ≤ sandbox `timeout_ms` |

Edge cases: command not found or spawn failure is `error`, not `fail` — the
harness cannot distinguish a broken environment from failing tests, so it
refuses to score. Timeout is `error` with the timeout recorded as observed
value. Output streams are captured (bounded to 1 MiB each, truncation
marked) into the trajectory record for diagnosis but never affect the
verdict.

```yaml
- type: tests_pass
  command: ["npm", "test", "--", "--run"]
  timeout_ms: 180000
```

### 4.4 `file_exists`

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `path` | string | yes | — | workspace-relative, forward slashes, no `..` segments, no leading `/` |
| `kind` | string | no | `file` | `file`, `dir`, or `any` |

Passes iff the path exists in the workspace snapshot with the declared kind.
A symlink in the snapshot is compared by its own kind (`any` matches it);
symlinks are never followed during assertion evaluation.

```yaml
- type: file_exists
  path: src/cache/lru.ts
```

### 4.5 `file_absent`

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `path` | string | yes | — | same path rules as `file_exists` |

Passes iff nothing exists at the path. Useful for asserting the agent did
not scatter scratch files or commit build output.

```yaml
- type: file_absent
  path: debug.log
```

### 4.6 `file_contains`

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `path` | string | yes | — | same path rules as `file_exists` |
| `literal` | string | one of | — | non-empty; exactly one of `literal` / `regex` |
| `regex` | string | one of | — | compiled with the `u` flag; bounded-complexity check at validate rejects patterns with pathological backtracking shape (`task_invalid`) |
| `min_count` | integer | no | `1` | ≥ 1 |
| `max_bytes` | integer | no | `10485760` | ≥ 1 |

Semantics: the file is decoded as strict UTF-8 (the only encoding in 1.0; a
BOM is stripped before matching). Line endings are matched as-is; authors
matching across lines use `regex` with explicit `\r?\n`. The assertion
passes iff at least `min_count` non-overlapping occurrences are found.

Edge cases: a missing file is `fail` with observed "file absent"; a file
that is not valid UTF-8 is `fail` with observed "not valid UTF-8" (the
content demonstrably does not contain the expectation as text); a file
larger than `max_bytes` is `error` — the harness refuses to scan unbounded
content rather than silently truncate.

```yaml
- type: file_contains
  path: src/cache/lru.ts
  regex: 'evictOldest\('
  min_count: 1
```

### 4.7 `json_schema`

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `path` | string | yes | — | target file, same path rules as `file_exists` |
| `schema` | string | yes | — | relative path to a JSON Schema (draft 2020-12) file inside the project root |

The schema file is compiled with Ajv in strict mode at validate time; a
schema that fails to compile is `task_invalid`. At evaluation, the target
file is parsed as JSON: a missing file or a parse failure is `fail`; a valid
document violating the schema is `fail` with the first five Ajv errors as
the observed value; conformance is `pass`. Remote `$ref` resolution is
disabled; a schema referencing a URL is `task_invalid`.

```yaml
- type: json_schema
  path: dist/report.json
  schema: ./schemas/report.schema.json
```

### 4.8 `diff_matches`

Compares the change the agent made against a committed expected patch
(FR-ASSERT-009).

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `expected` | string | yes | — | relative path to a unified-diff `.patch` file inside the project root |
| `ignore_whitespace` | string | no | `trailing` | `none`, `trailing`, or `all` |
| `paths` | list of strings | no | all files | restrict comparison to these workspace-relative paths |

Semantics, as ordered steps:

1. Compute the actual change set: a file-by-file diff between the
   materialized fixture state and the post-run workspace snapshot.
2. Parse the expected patch into per-file hunks. A patch that does not parse
   is `task_invalid` at validate time, never a runtime surprise.
3. Normalize both sides: apply the `ignore_whitespace` mode to every added
   and removed line (`trailing` strips trailing whitespace; `all` collapses
   all runs of whitespace to one space and strips ends); drop context lines
   entirely (context-line insensitivity — only `+`/`-` lines and the target
   file identify a change).
4. Compare as sets: for each file, the multiset of normalized removed lines
   and the multiset of normalized added lines must match exactly. Hunk
   boundaries and hunk order are ignored (hunk-order insensitivity), so an
   equivalent patch produced with different context or hunk splitting still
   matches.
5. Files changed in the workspace but absent from the expected patch (and
   vice versa) are mismatches, unless excluded by `paths`.

Edge cases: binary files compare by content hash — the expected patch
represents a binary change as a `Binary files differ` entry plus a required
sidecar hash line, and a textual comparison is never attempted. Renames are
represented as a delete plus an add; Git rename detection is deliberately
not used because its similarity threshold is heuristic. File mode changes
are ignored in 1.0. An expected patch that touches paths outside the
workspace root is `task_invalid`.

```yaml
- type: diff_matches
  expected: ./expected/fix-eviction.patch
  ignore_whitespace: trailing
```

### 4.9 `command_output`

Runs a command in the sandbox and matches one output stream.

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `command` | list of strings | yes | — | argv array, non-empty |
| `stream` | string | no | `stdout` | `stdout`, `stderr`, or `both` (concatenated stdout then stderr) |
| `equals` | string | one of | — | exact match after stripping one trailing newline |
| `contains` | string | one of | — | substring match |
| `regex` | string | one of | — | same regex rules as `file_contains` |
| `cwd` | string | no | sandbox `workdir` | as in `tests_pass` |
| `timeout_ms` | integer | no | `60000` | ≥ 1000, ≤ sandbox `timeout_ms` |

Exactly one of `equals` / `contains` / `regex` is required. The command's
exit status does not affect the verdict — pair with `tests_pass` or a second
assertion when status matters. Captured output is bounded at 1 MiB; output
exceeding the bound is `error` (never a silent truncation that could flip a
match). Spawn failure and timeout are `error`.

```yaml
- type: command_output
  command: ["node", "dist/cli.js", "--version"]
  stream: stdout
  regex: '^1\.[0-9]+\.[0-9]+$'
```

### 4.10 `trajectory`

Gates on a trajectory metric computed by the trajectory package
(FR-TRAJ-004). Metrics are versioned as `trajectory-metrics/1`
(FR-TRAJ-008); the fixed metric list for version 1:

| Metric | Type | Meaning |
| --- | --- | --- |
| `tool_selection_correctness` | ratio 0..1 | fraction of `expected_tools` invoked at least once |
| `ordering_violations` | count | violated instances of declared `ordering` constraints |
| `redundant_call_count` | count | tool calls identical (name + canonicalized arguments) to an earlier call whose result was also identical |
| `read_before_write_violations` | count | write-class calls to a path with no prior read-class call for that path |
| `unprincipled_loop_count` | count | maximal runs of three or more consecutive identical call/result pairs (retry after new information does not count, per FR-TRAJ-006) |
| `turns_to_completion` | count | adapter turns from first prompt to termination |
| `cost_per_turn` | dollars | reconciled run cost divided by `turns_to_completion` |

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `metric` | string | yes | — | one of the seven names above; anything else is `task_invalid` |
| `op` | string | yes | — | `<`, `<=`, `>`, `>=`, `==`, `!=` |
| `value` | number | yes | — | type-compatible with the metric (counts require integers) |

Edge cases: `tool_selection_correctness` and `ordering_violations` require
`trajectory_expectations` (§3.16) — without it the assertion is
`task_invalid` at validate time. `cost_per_turn` on a zero-cost synthetic
run compares against 0.0 and says so in the observed value. A trajectory
marked incomplete (FR-TRAJ-005) makes every trajectory assertion `error`,
never `fail`.

```yaml
- type: trajectory
  metric: redundant_call_count
  op: "<="
  value: 2
```

### 4.11 `checker`

Loads a TypeScript module and runs its exported `check` function in a
restricted worker (FR-ASSERT-003).

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `module` | string | yes | — | relative path to a `*.checker.ts` file inside the project root |
| `timeout_ms` | integer | no | `10000` | ≥ 100, ≤ 60000 |
| `memory_mb` | integer | no | `256` | ≥ 32, ≤ 1024 |

The module contract, in TypeScript:

```ts
import type {
  TaskDefinition,
  TrajectoryReader,
  WorkspaceReader,
} from "@assay/checker-api";

export interface CheckerContext {
  readonly task: TaskDefinition;
  readonly workspace: WorkspaceReader; // read-only snapshot access
  readonly trajectory: TrajectoryReader; // read-only trajectory access
  readonly log: (message: string) => void; // bounded, captured diagnostics
}

export interface CheckerVerdict {
  readonly verdict: "pass" | "fail";
  readonly observed: string;
  readonly expectation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function check(ctx: CheckerContext): Promise<CheckerVerdict>;
```

Worker restrictions: no network, no child processes, no filesystem access
beyond the read-only `workspace` and `trajectory` handles, wall-clock and
memory limits as declared. Imports are restricted statically: a checker may
import `@assay/checker-api` types and relative modules within its own
directory subtree; anything else is `checker_invalid` at validate time.

Static validation at `assay validate` time parses and type-checks the module
and confirms the `check` export and signature without executing any of it —
a missing export, wrong signature, syntax error, or forbidden import is
`checker_invalid` (FR-TASK-010).

A checker crash, unhandled rejection, timeout, memory kill, or a resolved
value that is not a structurally valid `CheckerVerdict` is `assertion_error`
— an error, never a failure (FR-ASSERT-004). The distinction is load-bearing:
a broken checker must not masquerade as a failing agent.

```yaml
- type: checker
  name: eviction-order-is-lru
  module: ./eviction-order.checker.ts
  timeout_ms: 5000
```

### 4.12 `judge`

An LLM-as-judge assertion, valid only under the ADR-0007 regime.

| Field | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `rubric` | string | no | task `judge.rubric` | relative path to a `*.rubric.yaml`; the effective rubric must exist |
| `threshold` | number | yes | — | 0 < threshold ≤ 1; minimum overall rubric score to pass |
| `k` | integer | no | `3` | odd, 1 ≤ k ≤ 5; majority of k votes decides, distribution stored (FR-JUDGE-009) |
| `advisory` | boolean | no | `false` | `true` forces advisory-only even when calibrated |

Rubric file schema (`*.rubric.yaml`):

```yaml
format_version: "1.0"
id: review-quality
version: 3
criteria:
  - id: correctness-of-findings
    description: Findings identify real defects with accurate reasoning.
    weight: 0.5
  - id: actionability
    description: Each finding proposes a concrete, applicable change.
    weight: 0.3
  - id: scope-discipline
    description: The review stays within the requested scope.
    weight: 0.2
calibration:
  set: ./calibration/review-quality-v3.jsonl
  labeled_items: 64
  provenance: >
    Two maintainers labeled independently; disagreements adjudicated by a
    third. Labeling guide committed alongside the set.
```

Rubric validation: weights are positive and sum to 1.0 (±1e-9); `criteria`
non-empty; `calibration.set` must exist and contain at least 50 items
(FR-JUDGE-002) — fewer is `task_invalid` for every task referencing the
rubric. `version` is an integer that must be bumped on any criteria change;
agreement statistics are stored per rubric version × judge model and are
invalidated by a version bump (FR-JUDGE-010).

Gating rule: a judge assertion may gate (contribute to pass/fail) only when
the stored calibration record for the effective rubric version × judge model
shows Cohen's kappa ≥ 0.6 (FR-JUDGE-004). Below that, the assertion runs
advisory-only: its verdict, votes, and agreement metadata appear in every
report surface (FR-JUDGE-007), but it cannot fail the task. `assay validate`
reports a gating judge assertion with no calibration record as
`judge_uncalibrated`; a judge assertion with no rubric at all is
`task_invalid` (FR-ASSERT-006).

Judge input isolation (delimiting, provenance labels, instruction
stripping) and the manipulation red-team suite are specified in
METHODOLOGY.md and are not restated here; judge calls are cost-accounted
and budget-gated like any provider call (FR-JUDGE-008).

```yaml
- type: judge
  rubric: ./review-quality.rubric.yaml
  threshold: 0.75
  k: 3
```

## 5. Suite schema

A suite selects tasks, declares variants, and configures comparison. All
violations are `suite_invalid` unless another category is named.

```yaml
format_version: "1.0"
id: coding-core
title: Core coding regression suite
include:
  - tasks/bugfix/**/*.task.yaml
  - tasks/refactor/rename-symbol.task.yaml
tags:
  any_of: [bugfix, refactor]
  none_of: [quarantined]
budgets:
  dollars: { limit: 4.00, aggregate: median, scope: suite }
spend_ceiling_dollars: 5.00
run_policy:
  n: 10
variants:
  baseline:
    adapter: robin
    model: synthetic/deterministic-1
    prompt_version: "2026-08-20"
    toolset_version: robin/1
    agent_version: "robin@0.4.2-pinned"
  candidate:
    adapter: robin
    model: synthetic/deterministic-1
    prompt_version: "2026-08-29"
    toolset_version: robin/1
    agent_version: "robin@0.4.2-pinned"
comparison:
  baseline_variant: baseline
  candidate_variant: candidate
  threshold: 0.05
  alpha: 0.05
  n: 10
allow_same_family_judge: false
```

### 5.1 Identity fields

`format_version`, `id`, and `title` follow the task rules (§3.1–§3.3), with
`suite_invalid` as the violation category. Suite ids share the task id
charset and are unique per project.

### 5.2 `include`

Required, non-empty list of paths or globs relative to the suite file,
resolving to `*.task.yaml` and `*.matrix.yaml` files inside the project
root (§2 glob semantics). A path entry that matches nothing is
`suite_invalid`; a glob entry that matches nothing is a warning, because
globs legitimately go empty as directories are reorganized. Matrix files
contribute their expanded instances (§6).

### 5.3 `tags`

Optional selector applied after `include` resolution. Sub-fields `any_of`,
`all_of`, and `none_of` are each optional lists of valid tags. A task is
selected iff it matches all present sub-selectors. A selection that ends
empty after tag filtering is `suite_invalid` — an empty suite gates nothing
and must not pass silently.

### 5.4 Deterministic ordering

The resolved task set is ordered first by its resolved project-relative
source path and then by task id (matrix instance id for expanded instances),
each in ascending UTF-8 byte order. Duplicate ids across the whole resolved
set are `suite_invalid` (§3.2). This ordering is the execution planning order
and the report row order (FR-TASK-006). Parallel execution may complete out
of order; ordering here fixes identity, not scheduling.

### 5.5 Suite budgets and spend ceiling

`budgets` follows §3.13 with `scope: suite` required (`scope: task` in a
suite file is `suite_invalid`). A suite-scoped budget aggregates the
declared statistic over all task runs in the suite for one variant
(FR-BUD-001, FR-BUD-005).

`spend_ceiling_dollars` (number, optional) is the runaway guard: when
projected spend exceeds it mid-suite, the suite aborts fail-closed
(FR-BUD-008, NFR-COST-004). It must be greater than or equal to the
suite-scoped dollar budget limit when both are present.

### 5.6 `variants` and `comparison`

`variants` is a map from variant name (task-id charset) to a variant
definition; at least one variant is required to run the suite.

| Variant field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `adapter` | string | yes | adapter id (e.g. `simulated`, `robin`) |
| `model` | string | yes | subject model identity string |
| `prompt_version` | string | no | opaque label distinguishing prompt revisions |
| `toolset_version` | string | no | tool-catalog selector override label |
| `agent_version` | string | no | subject agent version pin |

`comparison` is optional; without it `assay compare` requires explicit
run ids.

| Comparison field | Type | Default | Validation |
| --- | --- | --- | --- |
| `baseline_variant` | string | — | must name a declared variant |
| `candidate_variant` | string | — | must name a declared variant, distinct from baseline |
| `threshold` | number | `0.05` | 0 < t < 1; the pass-rate regression (absolute) that gates when statistically supported |
| `alpha` | number | `0.05` | fixed at 0.05 in 1.0; any other value is `suite_invalid` (ADR-0006 constants are not per-suite knobs) |
| `n` | integer | `10` | runs per task per variant; n < 5 is `suite_invalid` for a gating comparison (minimum n for any comparative claim) |

The statistical machinery behind a comparison — Wilson intervals, Newcombe
deltas, Boschloo tests, Benjamini–Hochberg FDR at q = 0.05, the seeded
stratified bootstrap for the suite delta, and the four permitted wording
outcomes — is defined solely by METHODOLOGY.md and ADR-0006. The suite file
only selects threshold and n.

### 5.7 `allow_same_family_judge`

Boolean, optional, default `false`. The suite-level half of the ADR-0007
same-family override (§3.15). When effective, every report that includes a
judged result carries the same-family flag.

## 6. Matrix schema

A matrix file expands one base task across declared axes at load time
(FR-TASK-005). Matrix violations use the `task_invalid` category, because a
matrix is a task generator, not a distinct runtime object.

```yaml
format_version: "1.0"
task: ./summarize-diff.task.yaml
axes:
  model: ["synthetic/deterministic-1", "synthetic/deterministic-2"]
  input_size: [small, large]
exclude:
  - { model: "synthetic/deterministic-2", input_size: large }
```

Fields:

- `format_version` (§3.1 rules).
- `task` (string, required): relative path to the base `*.task.yaml`. The
  base may be concrete or abstract; the expanded instances must validate as
  concrete tasks.
- `axes` (mapping, required, non-empty): axis name (task-id charset, at most
  4 axes) to a non-empty list of scalar values (strings, numbers, or
  booleans; unique within the axis). The full cross product before
  exclusions may not exceed 64 instances; more is `task_invalid`.
- `exclude` (list, optional): each entry is a mapping of axis name to value
  naming an exact combination to drop. An entry naming an unknown axis or
  value, or excluding every instance, is `task_invalid`.

Substitution: axis values are available to the base task as
`${{ matrix.<axis> }}` placeholders inside string scalar values only (prompt
text, env values, command elements, titles). Substitution is literal text
replacement at load time — no expressions, no execution. A placeholder
naming an unknown axis, or a placeholder remaining unresolved after
expansion, is `task_invalid`.

Instance id generation is deterministic: starting from the base task id,
append `--<axis>-<value>` for each axis in declaration order, with the value
slugified — lowercased, every run of characters outside `[a-z0-9]` replaced
by one `-`, leading/trailing `-` trimmed. Example:
`summarize-diff--model-synthetic-deterministic-1--input-size-small`.
Instance ids must satisfy the task-id charset with a relaxed length bound of
128 characters; a post-slug collision between two instances is
`task_invalid` naming both value combinations. Instance ids are stable
across runs and are the comparison identity for matrix instances.

## 7. Validation pipeline

`assay validate` (and the loading phase of `assay run`) executes these steps
in order, per file set. Validation is total, not fail-fast: every file is
carried through every step it can reach, and all diagnostics are reported
together. Any diagnostic yields exit code 4.

1. **Discovery and classification.** Resolve argument paths and globs;
   classify each file by suffix (§2). A path that resolves outside the
   project root or names no known kind: `invalid_invocation`.
2. **YAML parse.** Safe-mode parse per §1. Parse failure, duplicate keys, or
   custom tags: `task_invalid` / `suite_invalid` per the file's kind.
3. **Format version gate.** Check `format_version` before anything else so
   the error for a future-format file is always the version error, not a
   confusing schema error: `task_invalid/format-version-unsupported` or the
   suite equivalent (FR-TASK-007).
4. **JSON Schema validation.** Ajv strict mode against the published schema
   for the kind; unknown fields rejected: `task_invalid` / `suite_invalid`.
5. **Field-rule validation.** Regexes, bounds, cross-field rules (exactly
   one fixture form, `hosts` iff `allowlist`, one matcher per assertion):
   same categories as step 4.
6. **Inheritance resolution.** Resolve `extends` chains, apply merge rules,
   re-run steps 4–5 on each resolved document. Unresolved parent, chain too
   long, cycle, or illegal `+append:`: `task_invalid` (FR-TASK-004).
7. **Matrix expansion.** Expand matrices, substitute placeholders, generate
   instance ids, re-validate each instance as a concrete task:
   `task_invalid` (FR-TASK-005).
8. **Reference resolution.** Resolve prompt files, schema refs, expected
   patches, rubrics, and checker paths (missing: `task_invalid`); resolve
   fixture paths and archives (missing: `fixture_unavailable`); verify
   archive SHA-256 (`fixture_hash_mismatch`). Local reads only — never a
   network fetch (FR-TASK-008).
9. **Checker static validation.** Parse and type-check each referenced
   checker, verify the `check` export signature and the import restrictions,
   without executing any user code: `checker_invalid` (FR-ASSERT-003 shape,
   FR-TASK-010 no-execution).
10. **Assertion layering check.** Enforce deterministic → checker → judge
    ordering: `task_invalid/assertion-layer-order` (FR-ASSERT-002).
11. **Judge calibration check.** For each gating judge assertion, require a
    rubric (else `task_invalid`) and a calibration record with kappa ≥ 0.6
    for the rubric version × judge model (else `judge_uncalibrated`)
    (FR-ASSERT-006, FR-JUDGE-004).
12. **Suite resolution.** Resolve `include`, apply tag selectors, order
    deterministically, detect duplicate ids, validate variants and
    comparison config, check the task/suite `allow_same_family_judge`
    agreement: `suite_invalid` (FR-TASK-006, FR-TASK-012).

Diagnostics are stable: each carries the error category, a stable code
string, the file path, a YAML path to the offending node where applicable,
and a one-line remedy. Diagnostic output ordering is by file path then YAML
path, byte order, so validation output is diffable in CI.

## 8. Versioning and migration

### 8.1 `format_version` semantics

The task format is versioned independently of the Assay release version.
Version `1.x` is the only major that will ever exist before 1.0 ships. Rules:

- A **major** bump means an existing valid file may become invalid or change
  meaning. Loaders reject any major they do not implement with the stable
  version error from §7 step 3 — never a partial read, never a guess
  (FR-TASK-007).
- A **minor** bump adds optional fields or relaxes validation. Because the
  schema rejects unknown fields, a file declaring a minor newer than the
  loader is also rejected (§3.1); the error message states the installed
  Assay version that first supports the declared minor.
- Loaders never write. No code path in `assay validate`, `assay run`, or any
  other command modifies a task, suite, rubric, or matrix file. Silent
  rewriting is prohibited unconditionally (FR-TASK-011).

### 8.2 Migration command

`assay migrate <paths>` is the reserved migration command, introduced
alongside the first format change that needs it and owned by R10 evidence
(FR-TASK-011). Specified behavior:

- Default mode prints a unified diff of the proposed rewrite per file and
  changes nothing. `--write` applies the rewrite. There is no in-place mode
  without `--write`.
- Migration is deterministic and comment-preserving where the YAML layer
  allows; where a comment cannot be preserved, the migration output says so
  per file rather than dropping it silently.
- A file the migrator cannot mechanically migrate is reported with the
  manual steps required; the command exits 4 and writes nothing for that
  file even under `--write`.

### 8.3 Old-version fixture policy

Every shipped format migration is accompanied, in the same change, by:

- a fixture corpus under `fixtures/tasks/format-v<old>/` containing valid
  files of the old version, including edge cases (deep `extends` chains,
  `+append:` usage, matrices, every assertion type);
- CI tests that run `assay migrate` over the corpus, validate the output
  under the new version, and assert semantic equivalence of the resolved
  documents;
- CI tests that confirm the old files still produce the stable
  version-rejection error from an un-migrated loader path.

A format change without its corpus and tests does not merge. This is the
FR-TASK-011 evidence shape, proven terminally at R10.

## 9. Worked examples

Every example below is complete and intended to validate as-is against the
1.0 schemas once implemented.

### 9.1 Bug-fix task with tests, diff, trajectory, and budgets

```yaml
format_version: "1.0"
id: fix-lru-eviction
title: Fix the LRU cache eviction off-by-one
description: >
  fixtures/repos/lru-cache-bug is a small TypeScript package whose
  eviction test fails: the cache evicts the second-oldest entry. The agent
  must find and fix the defect without weakening the tests.
tags: [bugfix, typescript]
fixture:
  path: ../../fixtures/repos/lru-cache-bug
  git_init: true
prompt: >
  The test suite in this repository fails. Diagnose the failure, fix the
  underlying defect, and make the full test suite pass. Do not modify any
  test file.
toolset:
  catalog: robin/1
  allow: [read_file, write_file, run_command]
sandbox:
  image: ghcr.io/assay-fixtures/node22@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  network: none
  timeout_ms: 300000
trajectory_expectations:
  expected_tools: [read_file, write_file, run_command]
  ordering:
    - { first: read_file, then: write_file }
  read_before_write: true
assertions:
  - type: tests_pass
    command: ["npm", "test", "--", "--run"]
    timeout_ms: 180000
  - type: file_absent
    path: node_modules/.assay-scratch
  - type: diff_matches
    expected: ./expected/fix-lru-eviction.patch
    ignore_whitespace: trailing
    paths: [src/lru.ts]
  - type: trajectory
    metric: read_before_write_violations
    op: "=="
    value: 0
  - type: trajectory
    metric: redundant_call_count
    op: "<="
    value: 2
  - type: trajectory
    metric: turns_to_completion
    op: "<="
    value: 15
budgets:
  tokens: { limit: 60000, aggregate: median }
  wall_clock_ms: { limit: 240000, aggregate: p95 }
  tool_calls: { limit: 40, aggregate: median }
  dollars: { limit: 0.40, aggregate: median }
run_policy:
  n: 10
  seed: 42
```

Non-obvious choices. `diff_matches` is restricted with `paths: [src/lru.ts]`
so the assertion checks the fix itself while `tests_pass` checks the
outcome; without the restriction, any incidental edit (a lockfile touch, an
editor artifact) would fail the diff even when the fix is correct. The
trajectory bounds are behavioral quality gates the tests cannot see: an
agent that rewrites the file blind (`read_before_write_violations > 0`) or
thrashes (`redundant_call_count > 2`) can still pass the tests, and these
assertions are what makes Assay score the trajectory rather than only the
final answer. `git_init: true` gives `diff_matches` a stable baseline and
lets a Git-aware agent behave naturally. The p95 aggregate on wall clock
tolerates one slow run out of ten while the median token budget resists
being dragged by a single outlier in either direction.

### 9.2 `extends` plus a matrix across two models

The shared abstract parent:

```yaml
format_version: "1.0"
id: base-summarize
abstract: true
tags: [summarization]
toolset:
  catalog: simulated/1
  allow: [read_file]
sandbox:
  image: ghcr.io/assay-fixtures/minimal@sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
  network: none
  timeout_ms: 60000
run_policy:
  n: 10
  seed: 7
```

The concrete child, written for matrix substitution:

```yaml
format_version: "1.0"
id: summarize-diff
title: Summarize a committed diff (${{ matrix.input_size }} input)
extends: ./base-summarize.task.yaml
"+append:tags": [matrix]
fixture:
  archive:
    ref: fixtures/archives/diff-${{ matrix.input_size }}.tar
    sha256: "${{ matrix.fixture_sha }}"
prompt: >
  Read CHANGES.diff and write a three-sentence summary of the change to
  SUMMARY.md. Mention every modified file by name.
assertions:
  - type: file_exists
    path: SUMMARY.md
  - type: file_contains
    path: SUMMARY.md
    regex: 'src/'
  - type: trajectory
    metric: turns_to_completion
    op: "<="
    value: 6
```

The matrix:

```yaml
format_version: "1.0"
task: ./summarize-diff.task.yaml
axes:
  model: ["synthetic/deterministic-1", "synthetic/deterministic-2"]
  input_size: [small, large]
  fixture_sha:
    - "aa11d2f35c1e0b4b6d9c8a7f6e5d4c3b2a190807aa11d2f35c1e0b4b6d9c8a7f"
    - "bb22e3a46d2f1c5c7e0d9b8a7f6e5d4c3b2a1908bb22e3a46d2f1c5c7e0d9b8a"
exclude:
  - { model: "synthetic/deterministic-2", input_size: large }
```

Non-obvious choices. The parent is `abstract: true` and omits `fixture`,
`prompt`, and `assertions` entirely; only the resolved children are
validated as concrete tasks, so the parent stays a pure policy holder for
sandbox and toolset defaults. The child appends a tag with the quoted
`"+append:tags"` key instead of replacing the inherited list, which is the
one merge behavior that is opt-in rather than default. The matrix carries
`fixture_sha` as an explicit axis because substitution is literal text
replacement — the format has no way to derive a hash, and content
addressing must survive parameterization, so each `input_size` value pairs
with its archive hash and the mismatched cross-product combinations are cut
by `exclude`. Note that a `model` axis here parameterizes the task text and
instance identity; which model actually serves a run is still the variant's
`model` field (§5.6) — a matrix is how one compares per-task content across
models inside one variant, and the instance ids
(`summarize-diff--model-synthetic-deterministic-1--input-size-small--...`)
keep those instances statistically distinct.

### 9.3 Judged code-review task with rubric and calibration

The rubric (`review-quality.rubric.yaml`):

```yaml
format_version: "1.0"
id: review-quality
version: 3
criteria:
  - id: correctness-of-findings
    description: Findings identify real defects with accurate reasoning.
    weight: 0.5
  - id: actionability
    description: Each finding proposes a concrete, applicable change.
    weight: 0.3
  - id: scope-discipline
    description: The review stays within the requested scope.
    weight: 0.2
calibration:
  set: ./calibration/review-quality-v3.jsonl
  labeled_items: 64
  provenance: >
    Two maintainers labeled 64 trajectory excerpts independently against
    the committed labeling guide; disagreements were adjudicated by a
    third maintainer. Guide and raw labels are committed with the set.
```

The task:

```yaml
format_version: "1.0"
id: review-auth-change
title: Review a pull request that changes token validation
tags: [review, judged]
fixture:
  path: ../../fixtures/repos/auth-review
  git_init: true
prompt:
  file: ./review-auth-change.prompt.md
toolset:
  catalog: robin/1
  allow: [read_file, write_file]
sandbox:
  image: ghcr.io/assay-fixtures/node22@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  network: none
  timeout_ms: 240000
judge:
  rubric: ./review-quality.rubric.yaml
  model: { family_not: subject }
assertions:
  - type: file_exists
    path: REVIEW.md
  - type: file_contains
    path: REVIEW.md
    regex: 'src/auth/validate\.ts'
  - type: checker
    name: findings-reference-real-lines
    module: ./findings-lines.checker.ts
    timeout_ms: 5000
  - type: judge
    rubric: ./review-quality.rubric.yaml
    threshold: 0.75
    k: 3
budgets:
  dollars: { limit: 0.60, aggregate: median }
run_policy:
  n: 10
  seed: 3
```

Non-obvious choices. The assertion list demonstrates the mandatory
layering: two cheap deterministic checks establish that a review exists and
touches the changed file, a checker then verifies mechanically that every
cited line number exists in the fixture (something a regex cannot do and a
judge should not be trusted to do), and only then does the paid judge score
quality — an agent that produced no review never costs a judge call. The
judge gates only because the rubric's calibration set holds 64 human-labeled
items (above the 50-item floor) and assumes a stored kappa ≥ 0.6 for rubric
version 3 with the selected judge model; if that record were missing,
validation would report `judge_uncalibrated` and the assertion would run
advisory-only. `family_not: subject` keeps ADR-0007's default cross-family
independence, and the dollar budget covers the judge's own calls, which are
accounted like any provider call.

### 9.4 Suite with two variants and comparison config

```yaml
format_version: "1.0"
id: pr-gate
title: Pull request regression gate
include:
  - tasks/bugfix/**/*.task.yaml
  - tasks/review/review-auth-change.task.yaml
  - tasks/summarize/summarize-diff.matrix.yaml
tags:
  none_of: [quarantined]
budgets:
  dollars: { limit: 3.00, aggregate: median, scope: suite }
spend_ceiling_dollars: 5.00
run_policy:
  n: 10
variants:
  baseline:
    adapter: robin
    model: synthetic/deterministic-1
    prompt_version: "2026-08-20"
    toolset_version: robin/1
    agent_version: "robin@0.4.2-pinned"
  candidate:
    adapter: robin
    model: synthetic/deterministic-1
    prompt_version: "2026-08-29"
    toolset_version: robin/1
    agent_version: "robin@0.4.2-pinned"
comparison:
  baseline_variant: baseline
  candidate_variant: candidate
  threshold: 0.05
  alpha: 0.05
  n: 10
allow_same_family_judge: false
```

Non-obvious choices. The two variants differ in exactly one field,
`prompt_version` — the suite is a controlled experiment on a prompt change,
holding adapter, model, toolset, and agent version fixed, which is what
makes the comparison's causal reading defensible. Both variants run the
deterministic synthetic model, so this gate spends zero provider dollars in
required CI while still exercising every comparison code path; the dollar
budget and spend ceiling exist for the nightly configuration that swaps in
a real model. The `none_of: [quarantined]` selector is the standing
mechanism for pulling a flaky task out of the gate without deleting it or
its history. `threshold: 0.05` means a five-percentage-point pass-rate drop
is the practical-significance line; whether an observed drop actually fires
the gate is decided by the METHODOLOGY.md machinery (per-task Boschloo
tests under Benjamini–Hochberg FDR, suite-level bootstrap), never by the
point estimate alone, and n = 10 is the ADR-0006 default that the published
power tables cover.

## 10. Deferrals and requirements traceability

### 10.1 Deferred: multi-parent inheritance

`extends` accepts exactly one parent. Composition of multiple mixins is
deferred to OPEN_QUESTIONS.md, where it carries a fail-closed default (a
list value under `extends` is `task_invalid` today) and a reopen trigger
(three or more real suites demonstrating duplication that single-parent
chains cannot factor).

### 10.2 Deferred: remote fixture registries

Fixture archives are local repository files only. Fetching archives from a
registry or URL is deferred to OPEN_QUESTIONS.md with a fail-closed default
(any URL-shaped `archive.ref` is `task_invalid`; no network at load,
FR-TASK-008) and a reopen trigger (fixture corpus size making repository
storage impractical for a real adopter).

### 10.3 Deferred: non-YAML task sources

Generating tasks from code, notebooks, or recorded sessions is deferred to
OPEN_QUESTIONS.md. The fail-closed default is that only the five file kinds
in §2 exist and anything else is `invalid_invocation`; the reopen trigger
is a demonstrated authoring workload where YAML authoring is the measured
bottleneck.

### 10.4 Requirements traced

| Requirement | Where satisfied in this document |
| --- | --- |
| FR-TASK-001 | §1 goals 2–3, §7 steps 2–5 (published JSON Schemas, Ajv strict, validation before any run) |
| FR-TASK-002 | §3 (field register incl. id, title, fixture, prompt, toolset, assertions, budgets, run policy), unknown-field rejection §3 preamble and §7 step 4 |
| FR-TASK-003 | §1 goals 1–2, §2 (plain-text kinds, no execution at parse) |
| FR-TASK-004 | §3.7 (merge rules, `+append:`, cycle rejection), §7 step 6 |
| FR-TASK-005 | §6 (matrix expansion, substitution, deterministic instance ids), §7 step 7 |
| FR-TASK-006 | §5.2–§5.4 (include, tags, deterministic ordering) |
| FR-TASK-007 | §3.1, §7 step 3, §8.1 (unknown-major rejection with stable error) |
| FR-TASK-008 | §3.8, §7 step 8, §10.2 (content-addressed archives or in-repo paths, no network at load) |
| FR-TASK-009 | §3.11 (`network` default `none`, explicit allowlist with isolation downgrade, no ambient credentials in `env`) |
| FR-TASK-010 | §2 discovery, §7 (full pipeline without executing anything), §4.11 static checker validation |
| FR-TASK-011 | §8.2–§8.3 (migration command, old-version fixtures, never silent rewrite) |
| FR-TASK-012 | §3.2, §5.4, §6 (id regex, uniqueness, stability, FS/DB-safe charset) |
| FR-ASSERT-001 | §4.2–§4.9 (all eight deterministic types specified field-level) |
| FR-ASSERT-002 | §4.1 (layering rule, declared-order evaluation, validation) |
| FR-ASSERT-003 | §4.11 (`check(ctx)` contract, restricted worker, time and memory limits) |
| FR-ASSERT-004 | §4.11 (crash/timeout is `assertion_error`, distinct from failure) |
| FR-ASSERT-005 | §4.1 (type, target, observed, expectation, verdict, duration on every result) |
| FR-ASSERT-006 | §3.15, §4.12, §7 step 11 (judge invalid without rubric + calibration; loader rejection) |
| FR-ASSERT-007 | §4.12 (agreement metadata and same-family flag on every judged surface) |
| FR-ASSERT-008 | §4.1 (evaluation hermetic to workspace snapshot and trajectory) |
| FR-ASSERT-009 | §4.8 (committed expected patch; whitespace, context, and hunk-order insensitivity rules) |
| FR-ASSERT-010 | §4.3 (exit status only, in-sandbox, never heuristic log parsing) |

Trajectory metric definitions referenced by §4.10 are owned by the
trajectory package specification in ARCHITECTURE.md and by METHODOLOGY.md;
this document fixes only their names, operand types, and assertion syntax.
