# Assay: Installation, Testing, Operations, and Release Plan

Document status: normative lifecycle, verification, and release specification
for the Assay evaluation harness. R0 and R1 are accepted; later gates, release
commands, and product measurements remain planned.

Last revised: 2026-08-30.

Companion sources of truth:

- [Product requirements](PRODUCT_REQUIREMENTS.md)
- [Exhaustive build plan](BUILD_PLAN.md)
- [Architecture](ARCHITECTURE.md)
- [Statistical methodology](METHODOLOGY.md)
- [Task and suite format](TASK_FORMAT.md)
- [Agent adapter compatibility](AGENT_COMPATIBILITY.md)
- [Threat model](THREAT_MODEL.md)
- [Privacy and data handling](PRIVACY_AND_DATA.md)

This plan governs the complete lifecycle of Assay as a CI regression gate for
coding and tool-using agents: developer bootstrap, repository protection,
dependencies, local data, configuration, test design, CI, packaging,
installation, updates, rollback, deletion, diagnostics, incident response, and
R0-R10 release evidence.

Current baseline, stated verbatim wherever the current state is described:

> Assay is under implementation. Gates R0 and R1 are accepted with repository
> governance, task-format, deterministic runner, assertion, store-core, and
> cross-platform CI evidence. Gates R2 through R10 remain planned. No sandbox,
> real-provider, trajectory, budget, statistical, judge, Action, viewer, or
> packaged-release gate is accepted.

Assay's default architecture is one local CLI process (`assay`) operating on a
project checkout, a per-project SQLite-plus-blob trace store under `.assay/`,
and an OCI-container sandbox for task execution. Assay does not require a
hosted service, a resident daemon, a server database, or telemetry. A container
runtime is required only for sandboxed task execution; validation, comparison,
reporting, and viewing stored runs work without one.

## 1. Operating Model and Lifecycle Invariants

### 1.1 Lifecycle coverage

This document supplies concrete controls for all of these stages:

1. Authenticate the GitHub CLI before any repository or release operation.
2. Create, protect, and maintain the Git repository.
3. Bootstrap a clean developer machine without hidden global state.
4. Review, pin, install, update, and remove dependencies.
5. Resolve platform support and sandbox capability.
6. Create and protect local project stores, caches, and configuration.
7. Validate configuration before any run, comparison, or provider call.
8. Test the task format, runner, sandbox, adapters, providers, trajectory
   capture, budgets, statistics, judges, CI integration, store, and viewer.
9. Separate deterministic zero-dollar CI from bounded paid nightly smokes.
10. Measure harness overhead, viewer latency, suite throughput, and spend.
11. Build and verify the npm package, container image, and GitHub Action.
12. Install, update, migrate, roll back, uninstall, and purge exact owned
    resources.
13. Diagnose failures and create redacted support bundles.
14. Apply explicit retention, export, and deletion mechanics.
15. Respond to credential, fixture, sandbox, and spend incidents.
16. Close R0 through R10 only with requirement-linked evidence.

### 1.2 Default local process topology

The normal path is deliberately small:

```text
developer terminal or CI runner
       |
       v
one assay process
  suite loader and validator
  run orchestrator and state machine
  adapter subprocess supervisor (assay-adapter/1 JSONL)
  sandbox driver (Docker Engine API)
  assertion engines (deterministic, checker worker, judge client)
  budget evaluator and statistics engine
  redaction boundary
       |
       +---- .assay/ project store (SQLite WAL + content-addressed blobs)
       +---- container runtime socket (sandboxed task execution)
       +---- explicit provider endpoints (BYOK, only when configured)
       +---- adapter subprocesses inside sandboxes
```

The CLI owns its adapter subprocesses, sandbox containers, store writer
connection, and provider requests, and it releases all of them on handled
exit. `assay view` starts a loopback-only, token-authenticated, read-only
server for the duration of the command and nothing else. No Assay command
starts a background service.

### 1.3 Non-negotiable operations invariants

- A user-facing claim is current only after its named automated evidence
  passes on the supported matrix from a single commit.
- No required CI check calls a live model provider or spends money. Required
  CI evidence is deterministic and reproducible (NFR-DET-001, NFR-COST-001).
- A provider credential never appears in argv, configuration files, traces,
  reports, logs, diagnostic bundles, package artifacts, Git, or CI artifacts
  (NFR-SEC-001). Redaction happens at the capture boundary and fails closed
  per ADR-0010.
- Sandbox unavailability is a stable `sandbox_unavailable` error with a
  remediation message. It never silently degrades to host execution
  (FR-SAND-009). Host execution exists only behind `--unsafe-host-exec` with
  a persistent report banner (FR-SAND-010).
- A single run is never a quality claim. Every comparing surface reports pass
  rates over n runs with confidence intervals, and only the four permitted
  result phrases are emitted (FR-STAT-001, FR-STAT-007).
- Infrastructure error is never scored as task failure; task outcome and run
  lifecycle state are orthogonal (FR-RUN-003).
- Unreconciled usage fails budget gates closed (ADR-0009, FR-BUD-003).
- Every sandbox container and volume is labeled and reaped on exit, on
  signal, and by `assay gc` on next start (FR-SAND-006).
- Reruns append; no command mutates or overwrites a prior run's records
  (FR-RUN-009).
- Cleanup and deletion resolve exact validated targets and report partial
  failure; nothing performs broad recursive deletion outside `.assay/`.
- Release automation publishes only the exact reviewed commit and immutable
  dependency lock, with provenance for every artifact.
- A flaky test in a required suite is a release blocker. An evaluation
  harness whose own evidence flakes cannot credibly gate anyone else's pull
  requests.

### 1.4 Status vocabulary

Lifecycle documentation uses exactly these four statuses:

| Term | Meaning |
| --- | --- |
| Accepted | Implemented on mainline and backed by its named automated gate. |
| In progress | Present on a branch; not a release claim. |
| Planned | Specified but not implemented; no current support claim is permitted. |
| Deferred | Deliberately outside the named phase and forbidden as completion evidence. |

A package, type declaration, stub, or happy-path unit test is never
completion. Every claim in README.md and MARKETING.md must resolve to one of
these four statuses, and the `lint-docs` CI check enforces the current-versus-
planned separation (NFR-MAINT-004).

### 1.5 Global release pass rule

A gate passes only when all applicable checks are green from the same commit:

- source and generated-file policy;
- strict type checking and architecture boundary checks;
- deterministic unit, property, golden, integration, e2e-simulated,
  adversarial, and migration suites assigned to the gate;
- supported-platform matrix cells assigned to the gate;
- package installation and uninstall smoke tests once packaging exists;
- migration fixtures for any persisted-format change;
- planted-credential redaction scan over logs and artifacts;
- requirement-to-evidence validator (Section 19);
- documentation that separates current from planned behavior;
- no unresolved critical or high security defect in the shipped scope.

Rerunning only a failed job does not erase the first failure. The gate record
links both attempts and states whether the cause was code, test
nondeterminism, or runner infrastructure. A nondeterminism cause opens a
flake-quarantine issue under Section 8.7 and blocks the gate until resolved,
because required suites carry a zero-flake policy.

## 2. Supported Environment and Capability Matrix

### 2.1 Support tiers

- **Tier 1:** every pull request runs the full deterministic suite; release
  candidates additionally run packaging, installation, migration, and
  performance evidence on these platforms.
- **Tier 2:** main and release candidates run the applicable suite; known
  platform differences are documented and no Tier 1 parity claim is made.
- **Unsupported:** startup may work, but Assay makes no operational or
  isolation guarantee, and issue reports require reproduction on a supported
  target.

### 2.2 Host operating-system matrix

| Platform | Architecture | Tier | Required behavior |
| --- | --- | --- | --- |
| macOS 14 or newer | arm64 | Tier 1 | Source/npm install, full CLI, sandbox via Docker Desktop or a Podman-compatible socket, viewer, store. |
| macOS 14 or newer | x64 | Tier 2 | Same CLI semantics; evidence limited to what hosted runners provide. |
| Ubuntu 22.04 LTS or newer | x64 | Tier 1 | Source/npm install, full CLI, sandbox via Docker Engine 24+ or rootless Podman socket, viewer, store; primary CI platform. |
| Ubuntu 22.04 LTS or newer | arm64 | Tier 2 | Same source behavior; container-image evidence requires an arm64 build job. |
| Windows 11 via WSL2 (Ubuntu 22.04+) | x64 | Tier 2 | Linux CLI, store, and sandbox paths inside WSL2; Docker Desktop WSL2 backend; host-path performance caveats documented. |
| Native Windows | any | Unsupported | No claim. `assay doctor` detects native Windows and directs the user to WSL2. |
| Other Linux distributions | supported Node architectures | Unsupported | May run from source; distro-specific container-socket behavior is unclaimed. |

A newly released OS version enters Tier 2 first, completes the compatibility
suite on hosted runners, and moves to Tier 1 in a documented Assay release.

### 2.3 Node.js and npm matrix

| Component | Minimum | Release matrix | Policy |
| --- | --- | --- | --- |
| Node.js | 22.0.0 (22 LTS line) | Latest security patch of Node 22 LTS | `package.json` `engines` enforces the minimum; `.node-version` pins the tested patch. A newer LTS line enters Tier 2 only after the full matrix passes on it. |
| npm | 10.0.0 | npm bundled with the tested Node 22 line | CI uses `npm ci --ignore-scripts`; dependency changes use reviewed exact-version installation. |
| TypeScript | Exact lockfile version | One version per commit | Compiler upgrades require full type, schema, golden, and package checks. |

`assay --help` and `assay --version` must work without loading the sandbox
driver, provider clients, store, or viewer modules.

### 2.4 Sandbox capability matrix

Sandboxed execution is required for `assay run` unless `--unsafe-host-exec`
is explicitly passed. The sandbox driver speaks the Docker Engine API over a
local socket (ADR-0004).

| Backend | Platform | Prerequisite | Claim |
| --- | --- | --- | --- |
| Docker Engine 24 or newer | Tier 1 Linux, WSL2 | Engine socket reachable by the invoking user | Full sandbox contract: dedicated container per task run, `--network none` default, read-only root, tmpfs scratch, CPU/memory/pids limits, labeled reaping. |
| Docker Desktop (current stable) | Tier 1 macOS, Windows-host WSL2 integration | Docker Desktop running with the standard socket | Same contract through the Desktop VM; shared-kernel boundary is the Desktop VM kernel. |
| Rootless Podman socket (Docker-compatible API) | Linux | `podman system service` socket; API compatibility probe passes | Same contract where the compatibility probe verifies each required capability; unverified capabilities downgrade to a documented Tier 2 sandbox claim. |
| No container runtime | any | none | `assay run` fails with the stable `sandbox_unavailable` error, exit code 5, and a remediation message naming this section. Never silent host execution. |
| `--unsafe-host-exec` | any | explicit flag on every invocation | No isolation claim. Every report, comparison, and viewer surface rendering these runs carries a persistent unsafe-host-exec banner. |

Isolation claims are bounded per ADR-0004: the container shares a kernel with
the host (or the Desktop VM), and a compromised kernel or container daemon is
outside the defended boundary. Escape-attempt tests named in THREAT_MODEL.md
run in CI (FR-SAND-007) and are enumerated in Section 10.5.

`assay doctor` reports the detected runtime, API version, socket path,
rootless status, capability probe results, and achieved sandbox tier without
creating containers other than a labeled probe container that it removes.

### 2.5 CI runner matrix

All CI runs on GitHub-hosted runners:

| Runner | Purpose |
| --- | --- |
| `ubuntu-24.04` (4-core) | Required checks: typecheck, lint-docs, unit-property, integration, e2e-simulated, migration, redaction, store suites. |
| `ubuntu-24.04` (Docker preinstalled) | Sandbox suite, sandbox-escape suite, action-integration, container-image build. |
| `ubuntu-24.04` 8-core larger runner | Statistical simulation, mutation testing, performance measurement (Section 12). |
| `macos-14` (arm64) | Tier 1 macOS cells: unit-property, integration, e2e-simulated, package smoke. macOS sandbox evidence is release-candidate scope because hosted macOS runners lack nested virtualization guarantees. |

Runner images are referenced by their stable labels; the exact image version
of each evidence run is recorded in the gate evidence record. Required checks
never depend on a self-hosted runner.

### 2.6 Per-release compatibility record

Every release records, generated from test facts rather than hand-written:

- Assay version, commit, tag, build timestamp, and channel;
- Node, npm, TypeScript, OS, architecture, and runner image matrix;
- container runtime name, version, and capability probe results per cell;
- adapter contract version (`assay-adapter/1`) and conformance-suite version;
- pinned Robin version and flag spellings tested by `adapter-robin`;
- task format, store schema, event union, and Action input versions;
- npm tarball hash, container image digest, SBOM hash, and provenance link;
- known exclusions and Tier 2 degradations.

Release automation fails if a claimed Tier 1 cell lacks an associated
successful job and artifact from the release commit.

## 3. Repository, Git, and Branch Protection

### 3.1 Canonical repository identity

The canonical remote is:

```text
https://github.com/Zachshotamartin/Assay.git
```

The repository is created and configured exclusively through the
authenticated GitHub CLI (Section 4.1 makes authentication the first
bootstrap step; BUILD_PLAN ticket R0.01 is its implementation ticket):

```bash
gh auth status
gh repo create Zachshotamartin/Assay --public --clone
cd Assay
git remote get-url origin
```

Branch protection, required checks, secrets, and releases are likewise
managed via `gh api` and `gh` subcommands so that every repository-shaping
action is attributable to the authenticated account recorded in the R0
evidence. The repository name, default branch, npm package metadata, binary
name, help text, documentation, and provenance all use Assay; the executable
is exactly `assay`.

### 3.2 Working branches

- Feature work uses `feat/<short-topic>`, fixes use `fix/<short-topic>`;
  names are lowercase and hyphenated.
- One branch owns one coherent review scope. A security fix may include its
  regression test but does not absorb unrelated refactors.
- Before editing, record `git status --short`, the current branch, and the
  base commit. Stage explicit paths; `git add -A` is not used when unrelated
  changes exist.
- Automation never uses `git reset --hard`, `git clean -fd`, or forced
  checkout to recover a fixture or worktree.
- Generated artifacts are committed only when named as source-controlled
  evidence (golden fixtures, recorded-provider fixtures, schema files).
  Build output, local `.assay/` stores, diagnostic bundles, and any file
  containing a credential shape are ignored and blocked by the redaction
  pre-commit check.

### 3.3 Pull-request requirements

Every pull request includes:

- user-visible problem and outcome;
- gate and requirement IDs affected;
- exact packages and documents changed;
- current-versus-planned claim impact;
- risk classification: sandbox boundary, redaction, statistics, budget,
  store format, adapter contract, Action permissions, release, or none;
- tests run with commands and platform;
- new fixtures, schemas, migrations, dependencies, and release impact;
- failure and rollback behavior.

Changes to the redaction ruleset, sandbox driver, statistics engine, budget
evaluator, judge isolation transform, store migrations, or Action permission
scopes require a security-boundary review. Golden and recorded-fixture
changes are reviewed semantically; regeneration alone is not approval
(NFR-MAINT-005).

### 3.4 `main` branch protection

Once each job exists, protect `main` via `gh api` with:

- pull request required; force pushes and branch deletion disabled;
- at least one approving review; two for security-boundary changes;
- required conversation resolution;
- required status checks pinned to current workflow job names;
- repository administrators subject to the same rules except documented
  outage recovery;
- GitHub Actions token default permissions set to `contents: read`;
- release environment approval separate from merge approval;
- tag protection for `v*`.

The initial required checks at R0 are `typecheck`, `lint-docs`,
`unit-property`, and `arch-boundaries`. R1 adds `e2e-simulated` and
`store-core`; R2 adds `sandbox-linux`; R3 adds `recorded-provider`; R4 adds
`trajectory` and `redaction-corpus`; R5 adds `budgets`; R6 adds
`stat-simulation` and `mutation-stats`; R7 adds `judge-redteam`; R8 adds
`action-integration`; R9 adds `viewer-regression`; R10 adds
`release-candidate`. A required check is enabled only after it exists on the
default branch so protection never creates an impossible merge state.

### 3.5 Release tags and protected artifacts

- Release candidates use annotated tags `vMAJOR.MINOR.PATCH-rc.N`.
- Public releases use annotated, protected `vMAJOR.MINOR.PATCH` tags.
- The tag points to the commit whose CI run built the artifacts; release
  jobs never rebuild from a moving branch.
- Changelog, compatibility record, SBOM, checksums, provenance, npm tarball,
  and container image digest share one release ID.
- A tag is never moved. A faulty release is deprecated and replaced by a new
  patch release.
- Release publication runs through the authenticated `gh release create`
  path with signed checksums (Section 13).

### 3.6 Fixture governance

Task, suite, repository, trajectory, provider, secret, statistics, and judge
fixtures live under `fixtures/` and are synthetic. Each fixture directory
declares:

- fixture schema and generator version;
- content hash of the archive or directory manifest;
- the suites that consume it;
- absence of real credentials, real user repositories, and copied private
  transcripts (verified by the planted-credential scanner in reverse: no
  fixture may contain a string matching the redaction ruleset unless it is a
  registered synthetic canary).

Recorded-provider fixtures additionally record the provider dialect, the
sanitization pass version that stripped credentials and identifiers, and the
capture date. Regenerating any golden or recorded fixture runs through an
explicit `npm run fixtures:regen -- <path>` command whose diff is reviewed
semantically (NFR-MAINT-005).

### 3.7 Repository security settings

- Enable private vulnerability reporting before public release.
- Enable dependency alerts and lockfile review.
- Keep secret scanning enabled; tests use only registered synthetic canaries.
- Disable workflow execution from untrusted forks with repository secrets;
  fork PRs run the zero-credential lane only (FR-CI-007).
- Require approval for first-time contributors before privileged workflows.
- Pin third-party GitHub Actions to immutable commit hashes.
- Disable unused repository features unless they have an owner.

## 4. Exact Developer Bootstrap

### 4.1 Step 1: GitHub CLI authentication

The first step of the entire plan — before toolchain installation, before
cloning by any other means, before any repository-shaping action — is
authenticating the GitHub CLI. This ordering is deliberate and binding:
repository creation (Section 3.1), branch protection (Section 3.4), Action
integration tests (Section 9.7), and release publication (Section 13) all
depend on an authenticated `gh`, and every later GitHub-touching step lists
this step as its prerequisite.

```bash
gh auth login
gh auth status
gh api user --jq .login
```

Pass criteria:

- `gh auth login` completes for github.com with a token that has `repo` and
  `workflow` scopes;
- `gh auth status` reports the expected account and token scopes;
- `gh api user --jq .login` returns the expected login over an authenticated
  read-only probe;
- the authenticated account has permission to create and push the canonical
  repository (verified at R0 by the repository-creation ticket).

The authenticated account name is recorded in the R0 gate evidence. If any
of these checks fails, bootstrap stops here; nothing later in this section
may be attempted against GitHub unauthenticated.

### 4.2 Toolchain and clean clone

```bash
gh repo clone Zachshotamartin/Assay
cd Assay
git status --short
node --version
npm --version
```

Node 22 LTS is selected via the committed `.node-version` file; developers
using a version manager (`fnm`, `nvm`, `mise`) activate it from that file.
`node --version` must satisfy the `engines` range. An unsupported Node or
npm version fails before install with the observed and required ranges.

### 4.3 Deterministic install, build, and unit evidence

```bash
npm ci --ignore-scripts
npm run build
npm run test:unit
node apps/cli/dist/bin.js --version
node apps/cli/dist/bin.js --help
```

Pass criteria:

- the clone is on `main` with an empty status before installation;
- `npm ci --ignore-scripts` consumes the committed lockfile without
  rewriting it and runs no dependency lifecycle script;
- `npm run build` produces every workspace distribution without source
  changes;
- `npm run test:unit` passes the unit and property suites deterministically;
- version and help identify the product as Assay and load no sandbox,
  provider, store, or viewer module;
- `git status --short` after build contains only documented ignored build
  output.

### 4.4 Optional sandbox verification

Sandbox-dependent suites require a container runtime from Section 2.4.
Verify without mutating anything:

```bash
docker version --format '{{.Server.Version}}'
docker info --format '{{.OperatingSystem}}'
npm run test:sandbox
```

A missing or unreachable runtime marks only the sandbox-specific suites
unavailable locally; every other suite runs without one. Developers never
need `sudo` for Assay itself; installing Docker Desktop or configuring a
rootless socket is an explicit developer choice outside Assay.

### 4.5 Planned doctor

Once implemented (R2 for sandbox checks, complete at R10), `assay doctor` is
the packaged equivalent of this section: a read-only report of OS,
architecture, Node, npm, container runtime and capability probes, store
location and schema version, config precedence sources, and active `ASSAY_*`
overrides with secret-shaped values redacted. Section 15.1 enumerates its
check categories. The doctor never installs packages, edits shell startup
files, starts services, or contacts a provider.

### 4.6 Bootstrap failure policy

- Unauthenticated `gh` fails step 1 and blocks every GitHub-touching step;
  local-only development of already-cloned code may proceed but cannot
  produce gate evidence.
- Unsupported Node/npm versions fail before build with exact ranges.
- A lockfile mismatch fails; bootstrap never runs `npm install` to repair it.
- A dependency lifecycle-script requirement fails dependency review rather
  than bypassing `--ignore-scripts`.
- A missing container runtime marks only sandbox suites unavailable.
- A missing provider key never blocks deterministic development; no
  bootstrap step requires one.
- A dirty source tree is reported, not cleaned.
- Failure output contains no environment values, credential bytes, or
  absolute home paths in uploaded CI annotations.

## 5. Dependency and Supply-Chain Policy

### 5.1 Exact-version and lockfile rules

- Runtime and development dependencies are exact-pinned in package
  manifests; no `^` or `~` ranges.
- `package-lock.json` is the only supported dependency lock for source and
  CI (NFR-SEC-006).
- CI and clean bootstrap use `npm ci --ignore-scripts` exclusively;
  `npm install` is permitted only on a deliberate dependency-change branch.
- Manifest and lockfile changes land in the same pull request.
- Registry, resolved URL, integrity hash, package count, license, lifecycle
  scripts, native binaries, and transitive changes are reviewed before
  merge.
- Git URL, local path, mutable tag, and arbitrary binary-download
  dependencies require an accepted supply-chain ADR.
- Production packaging does not run dependency install scripts.

### 5.2 Dependency intake record

Every new runtime dependency has a review record containing:

1. exact problem and owning package boundary;
2. why Node, the OS, or an existing dependency is insufficient;
3. package name, exact version, registry source, maintainers, and release
   cadence;
4. direct and transitive package count and installed size;
5. license and notice obligations;
6. lifecycle scripts, native modules, bundled binaries, and post-install
   behavior;
7. public vulnerability history relevant to Assay's use;
8. permissions and data reachable at runtime;
9. deterministic test seam and synthetic substitute;
10. update, rollback, and removal cost;
11. alternative considered and reason rejected.

The record is linked from the pull request and included in the release SBOM.

### 5.3 Allowed dependency categories

After intake review, Assay may use:

- Ajv behind the strict schema-validation boundary in `packages/contracts`
  and `packages/task-format` (ADR-0001);
- better-sqlite3 inside `packages/run-store` only, behind the `RunStore`
  interface, with its native-build supply chain reviewed per release;
- official provider SDKs inside `packages/providers` adapters only, with
  exact request capture and recorded-fixture transport tests;
- a Docker Engine API client inside `packages/sandbox` only, behind the
  `Sandbox` interface;
- React and Vite for `apps/viewer` only, bundled at build time with no CDN
  or runtime network dependency (ADR-0011);
- Vitest and esbuild as development and build tooling (ADR-0001);
- audited checksum, SBOM, and provenance tooling used only in release jobs.

### 5.4 Core implementation exclusions

Assay implements its runner, task loader, assertion engines, trajectory
metrics, budget evaluator, statistics engine, judge calibration, redaction
boundary, store, and reporting in this repository.

Do not substitute:

- an agent framework or agent-loop package;
- an existing eval framework (promptfoo, inspect-ai, or similar) embedded as
  an engine — Assay's differentiating claims live in this code;
- an ORM or server database for the local trace store;
- a statistics library for the mutation-tested core in `packages/stats`
  (Wilson, Newcombe, Boschloo/Fisher, BCa bootstrap, BH FDR, and power
  computations are implemented and tested here, because a gate that blocks
  pull requests must be able to defend every number it prints);
- a workflow or job-queue engine for run orchestration;
- an ML-based secret detector for the redaction boundary (ADR-0010).

An exception requires an ADR showing why the dependency does not replace a
differentiating implementation and how it is contained and tested.

### 5.5 Update workflow

1. Create a dedicated dependency-update branch.
2. Record the old and proposed exact versions.
3. Review upstream release notes, integrity source, license, scripts,
   native artifacts, and transitive delta.
4. Update through npm with exact-save behavior.
5. Inspect `package.json` and `package-lock.json` as text and through the
   lockfile policy script.
6. Run `npm ci --ignore-scripts` in a fresh temporary clone.
7. Run typecheck, unit, integration, e2e-simulated, and affected platform
   suites.
8. Regenerate only semantically affected goldens and review every changed
   field.
9. Build the package tarball and scan its file inventory.
10. Record rollback to the prior lockfile.

Major provider SDK, TypeScript, better-sqlite3, or React/Vite updates
require a dedicated compatibility record.

### 5.6 Supply-chain release controls

- Generate SBOMs for the npm package and container image.
- Produce signed checksums after final artifact assembly, before upload.
- Generate build provenance from an isolated release job recording the Git
  commit, lockfile hash, runner image, Node version, and build command.
- Pin third-party workflow actions by commit hash.
- Never expose npm publishing tokens to tests or build scripts; publication
  uses short-lived trusted publishing where available.
- Compare the packed file list against an allowlist; fixtures containing
  synthetic secrets, local `.assay/` stores, `.env` files, and developer
  paths block publishing.
- Verify the published artifact in a clean job rather than trusting the
  pre-upload workspace.

## 6. Local Data, Configuration, Cache, and Credential Locations

### 6.1 Project store layout

Assay is project-local by design (ADR-0008). `assay init` creates exactly:

```text
<project>/.assay/
  assay.db            # SQLite, WAL mode: runs, tasks, turns, metrics,
                      # comparisons
  assay.db-wal        # WAL sidecar, managed by SQLite
  assay.db-shm        # shared-memory sidecar, managed by SQLite
  objects/            # content-addressed blobs
    <sha256[0..2]>/
      <sha256>        # trajectory JSONL, tool output, fixture manifests,
                      # workspace snapshots
  config              # store-format marker: schema version, created-by
                      # version, store id
```

Project configuration lives beside it as `<project>/assay.config.yaml`
(committed, never secret-bearing). The `.assay/` directory is added to the
project `.gitignore` by `assay init`; traces never enter version control.

### 6.2 Permissions

On POSIX platforms:

- `.assay/` and `objects/` subdirectories are created with mode `0700`;
- `assay.db` and the store `config` marker use mode `0600`;
- group- or world-writable pre-existing `.assay/` directories fail sensitive
  operations with a stable error naming `assay doctor`;
- blobs are written to a same-directory temporary file, flushed, and
  renamed; a blob is never partially visible under its hash name.

Within WSL2, the store must live on the Linux filesystem; a store on a
Windows-mounted path (`/mnt/c/...`) is detected and reported as degraded for
durability and performance.

### 6.3 Global cache

The only global location is a cache, safe to delete at any time:

```text
~/.assay/cache/
  images/            # pulled sandbox image digests (metadata only; images
                     # live in the container runtime)
  pricing/           # versioned pricing catalog snapshots (ADR-0009)
  fixtures/          # downloaded content-addressed fixture archives,
                     # verified by hash before use (NFR-SEC-007)
```

No run data, configuration, or credential material is ever written under
`~/.assay/`. Deleting the cache changes performance, never correctness.

### 6.4 Credential locations

Assay never writes a credential to disk (NFR-SEC-004). BYOK credentials
resolve at spawn time from:

- exact named environment variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or the variable named by the provider profile); or
- an OS keychain reference named in configuration, resolved through the
  platform keychain at use time.

Configuration files hold references (variable names, keychain item names),
never values. `assay doctor` reports which references resolve, with values
redacted. Sandbox containers receive only task-declared variables
(FR-SAND-004); provider credentials never enter a sandbox environment.

## 7. Configuration Precedence and Startup Validation

### 7.1 Precedence

Configuration resolves from highest to lowest precedence:

1. CLI flags;
2. `ASSAY_*` environment variables;
3. project `assay.config.yaml`;
4. built-in defaults.

Every effective value records its winning source for `assay doctor` output.
There is no user-global configuration file in 1.0; a project's behavior is
fully determined by its checkout plus explicit invocation inputs, which is
what makes CI runs reproducible from the repository alone.

### 7.2 Startup validation

Before any run, comparison, or provider call, Assay:

1. parses argv without filesystem or network effects; handles cold
   `--help` and `--version`;
2. loads and schema-validates `assay.config.yaml` with byte, depth, and
   item bounds; unknown keys are rejected with `invalid_configuration`
   naming the exact key and file position — never ignored;
3. validates `ASSAY_*` overrides against the same schema; an unknown
   `ASSAY_*` variable is rejected, not ignored, so typos cannot silently
   change behavior;
4. resolves the project store, checks the schema version, and refuses with
   `storage_migration_required` if `assay db migrate` is needed — never
   migrating implicitly on read (ADR-0008);
5. validates the requested suite and tasks (`assay validate` semantics)
   before creating any sandbox or contacting any provider;
6. resolves credential references without reading values until spawn time.

Failure at any step exits with code 4 (invalid input/configuration) or 5
(infrastructure), releases any acquired store lock, and identifies whether
any external effect occurred. Configuration errors never produce partial
runs.

## 8. Test Policy and Harness Rules

### 8.1 Evidence purpose

Tests prove named claims at the boundary that enforces them. Coverage
percentage alone does not prove isolation, redaction, statistical validity,
budget enforcement, or crash recovery. Every security, privacy, statistical,
and reliability claim maps to:

- a requirement ID from PRODUCT_REQUIREMENTS.md;
- an owning package boundary;
- one deterministic enforcement-boundary test;
- applicable integration and platform tests;
- a user-visible failure category from the error taxonomy;
- a release gate and evidence artifact.

Assay carries one obligation most projects do not: it is an evaluation
harness whose entire product claim is trustworthy pass/fail evidence about
other systems. Its own test policy is therefore stricter than it would
otherwise need to be — most visibly in the determinism controls (8.3) and
the flake policy (8.7).

### 8.2 Taxonomy

| Class | Purpose | External dependency | Frequency |
| --- | --- | --- | --- |
| Unit | Pure parsers, reducers, interval math, metric computation, wording contract, state transitions | None | Every PR |
| Property-based | Canonical serialization round-trips, task inheritance merge laws, interval coverage properties, redaction idempotence, matrix expansion determinism | Seeded generators only | Every PR with bounded seed corpus |
| Integration | Real temporary filesystems, real SQLite stores, real subprocesses, checker workers, tar streaming | Host primitives only | Every PR |
| E2E-simulated | Packaged `assay` CLI end to end against `adapter-simulated`; byte-reproducible results | None (in-repo scripted agent) | Every PR |
| E2E-robin-synthetic | `assay` end to end against `adapter-robin` wrapping pinned `robin --print` on the synthetic provider; deterministic and free | Pinned Robin version | Main and nightly; required lane at R4 |
| Recorded-provider | Real-provider code paths replayed from sanitized recorded HTTP fixtures via the fake provider server | None at run time | Every PR touching `packages/providers`; main otherwise |
| Nightly-paid-smoke | One tiny real-provider suite proving live wiring, usage reconciliation, and spend accounting | Real credential in protected environment | Nightly only; ceiling $5/run enforced by Assay's own budget gate (NFR-COST-002) |
| Sandbox-escape | Filesystem, network, process, resource-exhaustion, and fixture-poisoning escape attempts against the real sandbox | Container runtime | Every PR on the Docker-enabled Linux runner |
| Redaction-corpus | Planted-credential corpus through every capture surface | None | Every PR |
| Statistical-simulation | 1,000 seeded simulations with injected known effects and pure noise validating error rates, power, and wording | None | Every PR touching `packages/stats`; main otherwise; full corpus nightly |
| Mutation | Kill enforcement-branch mutants in `packages/stats` and `packages/trajectory`; score >= 85% (NFR-MAINT-002) | Mutator tooling | Main, stats/trajectory PRs, release |
| Action-integration | The GitHub Action against a real test PR in the canonical repository via authenticated `gh` | GitHub, R0.01 auth | Main and release; PR-triggered when `apps/action` changes |
| Viewer-regression and accessibility | Playwright against the built viewer over fixture stores; axe-core accessibility scan | Bundled browser | Every PR touching `apps/viewer`; main otherwise |
| Migration-fixture | Old-version store databases and task-format files migrated forward; interrupted-migration recovery | None | Every PR touching migrations; release always |

### 8.3 Determinism controls

Ordinary tests inject or pin:

- wall and monotonic clocks (no test reads real time for logic);
- ID generation and every PRNG seed, including the bootstrap seed
  (FR-STAT-009) and simulation seeds;
- adapter event scripts, timings, and usage numbers;
- pricing catalog version and effective date;
- sandbox capability reports where the real runtime is not under test;
- recorded provider responses, chunk boundaries, and fault schedules;
- filesystem fault schedules where injected;
- store schema origin for migration tests;
- network endpoints restricted to a unique loopback fake server.

There are no sleeps in any test: waiting synchronizes on explicit readiness
events, injected clocks advance virtually, and signal/cancellation tests use
readiness markers. Production uses real monotonic time, UTC timestamps, and
cryptographic randomness; tests never weaken production validation to obtain
deterministic output. No real provider call occurs in any required check
(NFR-DET-001). All harness randomness in production is itself seeded and
recorded in the run record (NFR-DET-002), so a production run is replayable
in a test.

### 8.4 Isolation and cleanup rules

Each test receives unique temporary roots for project checkout, store,
cache, sockets, and ports, created under the test runner's temp directory.
Tests do not share mutable singleton state.

Cleanup, executed from `finally` and verified by a suite-level leak
detector:

1. cancels and reaps every adapter subprocess and checker worker;
2. removes every sandbox container and volume by the test's unique label —
   every sandbox test tags its containers with `assay.test=<test-id>` and
   its teardown lists and removes by that label, so a crashed test leaves
   nothing an engine-wide `assay gc` sweep in CI teardown cannot find;
3. closes fake provider servers, viewer servers, file handles, and sockets;
4. removes only the verified temporary roots created for the test;
5. reports residual containers, processes, ports, or files as test
   failures in their own right.

Cleanup success never turns a failed assertion green. The CI teardown step
runs a final labeled-container sweep and fails the job if anything remained.

### 8.5 Fixture conventions

- Unit tests live next to source as `*.test.ts`; property tests as
  `*.property.test.ts` printing seed and minimized input on failure.
- Cross-adapter conformance suites export one reusable function
  instantiated by every adapter (FR-ADAPT-002).
- Integration tests live under package `test/integration/`; packaged e2e
  under `tests/e2e/`.
- Task, suite, repository, trajectory, provider, secret, statistics, and
  judge fixtures live under `fixtures/<kind>/` with the governance rules of
  Section 3.6.
- Golden fixtures are regenerated only by `npm run fixtures:regen` with
  semantic review (NFR-MAINT-005); a golden diff in a PR without the regen
  command in its description fails review.
- Every regression test title includes its issue or requirement ID.
- No fixture contains a real credential, real user repository content, a
  personal path, or a copied private transcript.

### 8.6 Timeout policy

- Every async test has a bounded test timeout and a shorter operation
  timeout; both derive from injected clocks where logic is under test and
  from generous real-time bounds where real subprocesses run.
- Timing assertions use monotonic elapsed time with dedicated-runner
  tolerances; wall-clock assertions are forbidden.
- A test retry is allowed only for identified runner-infrastructure
  failures (runner eviction, registry outage) and is recorded as such; a
  deterministic code test is never retried to conceal a race.

### 8.7 Flake policy

A flaky harness test is a defect in the product, not a nuisance:

- Any test observed to pass and fail on the same commit is quarantined
  within 24 hours: moved to an explicitly non-required quarantine lane with
  an owner, an issue, and the failing seed or artifact attached.
- A quarantined test that belongs to a required suite is a release blocker
  for every gate that lists that suite. The gate cannot pass while the
  quarantine is open — the eval harness cannot tolerate its own flakes
  while claiming to adjudicate other projects' regressions.
- Quarantine has a 14-day budget. After 14 days without a fix, the owning
  feature's status is downgraded from accepted to in progress and its
  documentation claims are updated in the same PR that records the
  downgrade.
- Fix the implementation or the test's determinism, never loosen the
  assertion; loosened assertions require the same semantic review as
  golden regeneration.
- The flake ledger (issue label `flake`) is reviewed at every gate closure
  and its state is part of the gate evidence.

### 8.8 Assertion and artifact rules

Tests assert trusted state, not rendered prose: exact event sequences,
store rows, blob hashes, exit codes, container inspect output, HTTP
request bytes received by the fake provider, and statistical values to
fixed tolerances. Report-text assertions exist only in the wording-contract
suite, where the text itself is the contract (FR-STAT-007).

Failure artifacts are allowlisted: fixture IDs, hashes, seeds, counts,
state-machine states, and redacted diagnostics. Trajectory contents, tool
output, provider payloads, credentials, and absolute user paths are
excluded unless the fixture is checked-in synthetic content and the job's
artifact policy names it. Every uploaded artifact passes the redaction
scanner before upload.

## 9. Shared Test Harnesses and Oracles

### 9.1 Simulated-adapter scenario harness

The scenario harness in `packages/adapter-simulated` drives the runner with
scripted deterministic agents. A scenario declares handshake parameters,
turn-by-turn events (text, tool calls with declared semantic classes,
malformed frames, stderr noise, errors, loops, budget-relevant usage), and
termination. Scenarios cover every `assay-adapter/1` contract feature
(FR-ADAPT-003) and every run-state-machine transition, including illegal
ones asserted as `internal_invariant`. The harness records the complete
`AssayEvent` sequence and compares canonical serializations byte-for-byte
against goldens (FR-RUN-004, NFR-DET-004).

### 9.2 Fake provider server

A loopback-only HTTP server replays sanitized recorded provider fixtures
for every supported dialect. It:

- binds an OS-assigned loopback port and rejects non-loopback peers;
- captures exact method, path, headers, and body bytes for fingerprint
  assertions;
- replays recorded JSON and SSE streams with configurable chunk
  boundaries, delays, malformed frames, truncation, rate-limit responses,
  and usage payloads (provider_rate_limit, provider_transient,
  provider_invalid_response coverage);
- serves usage numbers that deliberately disagree with the pricing catalog
  to exercise reconciliation and `usage_unreconciled` (ADR-0009);
- never receives or logs a real credential; auth headers are asserted to
  contain the synthetic canary only.

### 9.3 Sandbox escape harness

The escape harness runs hostile task fixtures inside the real sandbox and
verifies containment from outside the container:

- filesystem: attempts to read the harness checkout, host home, and other
  sandboxes' volumes; oracle is the workspace snapshot plus host-side
  inspection (FR-SAND-002, FR-SAND-012);
- network: attempts DNS and TCP egress under `--network none` and outside
  a declared allowlist; oracle is an independent host-side listener that
  must observe nothing (FR-SAND-003);
- process: attempts to exceed pids limits, daemonize, and outlive the run;
  oracle is container inspect and post-run process table (FR-SAND-005);
- resources: memory and disk exhaustion must yield
  `sandbox_limit_exceeded`, not host pressure (FR-SAND-005);
- fixture poisoning: archives with path traversal, symlink escapes, and
  hash mismatches must fail materialization with `fixture_hash_mismatch`
  or `fixture_unavailable` before any byte lands outside the container
  workdir (NFR-SEC-007);
- reaping: `SIGKILL` the harness mid-run, then verify the next start's
  `assay gc` removes every labeled container and volume (FR-SAND-006,
  FR-RUN-011).

### 9.4 Planted-credential corpus harness

Each run generates unique synthetic canaries shaped as provider keys, PEM
blocks, JWTs, cloud credentials, URL userinfo, and high-entropy tokens, in
raw, split, base64, URL-embedded, JSON-escaped, tool-output, and
trajectory-argument forms (ADR-0010). The harness plants them in adapter
events, tool output, env snapshots, fixtures, and diagnostics, runs the
capture path, then scans every persisted byte — store rows, blobs,
reports, logs, export bundles, support bundles, CI artifacts — for any
canary. One hit fails the suite. A deliberately broken redaction rule must
produce `redaction_failed`, block persistence of the record, and fail the
run as infrastructure error, proving fail-closed behavior.

### 9.5 Statistical simulation harness

The simulation harness in `packages/stats` validates the statistics engine
against ground truth it controls (FR-STAT-008):

- 1,000 seeded simulations per configuration cell in the full corpus (a
  seeded 200-simulation subset runs per-PR within the runtime budget);
- injected known effects: baseline pass probability p, candidate p plus a
  known delta, at n in {5, 10, 20, 50}; the engine must detect the effect
  at no less than the power the METHODOLOGY tables claim;
- pure-noise cells: identical distributions; the false-positive rate across
  simulations must not exceed alpha plus the simulation-count tolerance,
  and BH FDR must hold q <= 0.05 across per-task tests;
- interval coverage: Wilson and Newcombe intervals must achieve nominal
  coverage within tolerance across the grid;
- wording contract: every simulated comparison must emit exactly one of
  the four permitted phrases, and "insufficient data" must appear for
  every n < 5 cell (FR-STAT-007);
- the MDE and power tables published in METHODOLOGY.md are generated by
  this same code and diffed in CI (FR-STAT-012).

### 9.6 Store crash-injection harness

The crash harness runs store writes in a child process with fault markers
before and after every authoritative write (transaction commit, blob
rename, WAL checkpoint, migration step). It kills the child at each
marker, reopens the store with a fresh process, and asserts: committed
runs are intact, partial writes are invisible, partial trajectories carry
truncation markers (FR-TRAJ-009), corruption is detected and quarantined
rather than silently dropped (FR-TRACE-009), and interrupted migrations
resume from their durable cursor (FR-TRACE-006, FR-RUN-011).

### 9.7 Action integration harness

The Action harness exercises `apps/action` against reality (FR-CI-008),
depending on Section 4.1 authentication:

1. from CI, create a branch and open a real test PR in the canonical
   repository via authenticated `gh`;
2. push a change with a known injected regression fixture;
3. run the Action; assert it posts exactly one idempotently-updated PR
   comment containing the delta table with confidence intervals
   (FR-CI-002) and sets a failing status check (FR-CI-003);
4. push a no-effect change; assert the check passes and the same comment
   is updated in place, not duplicated;
5. assert the workflow token used only the documented least-privilege
   scopes (FR-CI-004) and no credential appeared in logs (FR-CI-005);
6. close the PR and delete the branch in teardown; leaked test PRs fail
   the suite.

The harness uses the simulated adapter only, so the real-PR loop spends
zero provider dollars.

### 9.8 Viewer Playwright harness

The viewer harness builds `apps/viewer`, starts `assay view` over
checked-in fixture stores, and drives it with Playwright:

- renders a 200-turn trajectory fixture and measures p95 render latency
  against Section 12 budgets (NFR-COST-006);
- diffs two runs of one task and asserts the first divergent turn is
  located and highlighted (FR-TRACE-005, FR-TRAJ-011);
- asserts read-only behavior: no mutation endpoint exists and mutating
  HTTP verbs return errors (FR-TRACE-008);
- asserts loopback binding and that requests without the session token
  are rejected (NFR-SEC-005);
- asserts zero external network requests from the page (ADR-0011);
- runs an axe-core scan on every route with no serious violations.

## 10. Detailed Verification Matrices

Each row is a required named test family. "Pass" means the stated oracle
holds on every assigned platform and the leak detector reports no residual
state. `Gate` in the CI-tier column means the suite is a merge-blocking
required check; `nightly` means scheduled on main. Every gate-tier suite
has a $0 cost ceiling (NFR-COST-001); the only paid row is PRV-008. Flake
policy abbreviations: `ZF` = zero-flake, quarantine within 24 hours,
blocks the named gate while quarantined (Section 8.7).

### 10.1 Task format and validation (`packages/task-format`, R1)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| TF-001 schema acceptance of every documented field | unit + Ajv boundary | `fixtures/tasks/valid/` | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-002 unknown-field and wrong-type rejection with exact key paths | unit + Ajv boundary | `fixtures/tasks/invalid/` | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-003 `extends` merge rules, override precedence, cycle rejection | unit | `fixtures/tasks/inheritance/` | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-004 `matrix` expansion determinism and stable instance ids | property-based | seeded generator corpus | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-005 suite selection by path and tag with deterministic ordering | unit | `fixtures/suites/selection/` | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-006 `format_version` negotiation; unknown major rejected stably | unit | `fixtures/tasks/versions/` | 15s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-007 task-id validity as filesystem and DB keys; collision rejection | property-based | seeded id generator | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-008 `assay validate` end to end: no execution, exit code 4 on invalid | e2e-simulated | `fixtures/suites/mixed-validity/` | 60s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| TF-009 parse-time inertness: hostile YAML anchors, bombs, huge inputs | unit adversarial | `fixtures/tasks/hostile/` | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| TF-010 format migration from old fixture versions; no silent rewrite | migration-fixture | `fixtures/tasks/format-migrations/` | 60s | gate (`unit-property`) | $0 | ZF; blocks R10 |

### 10.2 Runner and lifecycle (`packages/*`, composition in `apps/cli`, R1-R2)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| RUN-001 full state machine walk; every legal transition observed | simulated-adapter scenario | scripted scenario set | 90s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| RUN-002 illegal transitions raise `internal_invariant` and quarantine the run | simulated-adapter scenario | corrupted-scenario scripts | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| RUN-003 task outcome vs lifecycle orthogonality; infra error never scored | simulated-adapter scenario | error-injecting scenarios | 60s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| RUN-004 byte-reproducible scored results for fixed suite/variant/seed | simulated-adapter scenario | golden result set | 120s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| RUN-005 cross-platform byte-stability of RUN-004 goldens | simulated-adapter scenario | same goldens on macos-14 | 120s | gate (macOS lane) | $0 | ZF; blocks R1 |
| RUN-006 rerun appends; prior run records bit-identical after rerun | simulated-adapter + store | golden store fixture | 60s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| RUN-007 exit-code contract for the five R1-reachable outcomes (0/1/4/5/6), plus all-seven mapping tests | e2e-simulated | outcome-forcing scenarios | 90s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 (ADR-0015) |
| RUN-008 SIGINT/SIGTERM cancellation reaps adapters and sandboxes; `cancelled` persisted | sandbox escape harness | long-running task fixture | 180s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| RUN-009 bounded concurrency; no cross-run record interleaving | simulated-adapter scenario | 20-task parallel suite | 120s | gate (`integration`) | $0 | ZF; blocks R2 |
| RUN-010 run-record binding of content hashes, seeds, versions | simulated-adapter + store | golden run record | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |

### 10.3 Assertions (`packages/assertions`, R1-R2)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| AST-001 every deterministic assertion type against known workspaces | integration | `fixtures/repos/assertion-targets/` | 90s | gate (`integration`) | $0 | ZF; blocks R1 |
| AST-002 layered ordering deterministic -> checker -> judge enforced at load | unit | ordering fixtures | 15s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| AST-003 checker worker limits: time, memory; crash is assertion error not failure | integration | hostile checker modules | 120s | gate (`integration`) | $0 | ZF; blocks R1 |
| AST-004 checker sandbox: no network, no harness-state access from worker | integration adversarial | escaping checker modules | 90s | gate (`integration`) | $0 | ZF; blocks R2 |
| AST-005 assertion result record completeness (type, target, observed, verdict, duration) | unit | golden result records | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| AST-006 `diff_matches` context-insensitive matching per TASK_FORMAT rules | unit | patch fixture corpus | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| AST-007 `tests_pass` parses exit status only, inside sandbox | sandbox harness | test-command fixtures | 120s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| AST-008 hermeticity: assertions see only the workspace snapshot | sandbox harness | snapshot-vs-host fixtures | 90s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |

### 10.4 Adapters (`packages/adapter-*`, R1 and R4)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| ADP-001 `assay-adapter/1` handshake, framing, termination conformance | conformance suite | contract scenario scripts | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| ADP-002 unknown contract major rejected with stable error | conformance suite | future-version handshake | 15s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| ADP-003 malformed frames and stderr floods bounded and classified, never crash | simulated-adapter scenario | hostile frame scripts | 90s | gate (`integration`) | $0 | ZF; blocks R1 |
| ADP-004 simulated adapter covers text, tools, errors, loops, budgets deterministically | scenario harness | full scenario corpus | 120s | gate (`e2e-simulated`) | $0 | ZF; blocks R1 |
| ADP-005 tool-catalog semantic classes drive trajectory metrics | conformance + trajectory | catalog fixtures | 60s | gate (`unit-property`) | $0 | ZF; blocks R4 |
| ADP-006 robin adapter maps pinned `robin --print` stream-json onto contract | e2e-robin-synthetic | pinned Robin synthetic profile | 300s | gate at R4 (`e2e-robin`) | $0 | ZF; blocks R4 |
| ADP-007 robin adapter conformance tier reported as pinned-preview until Robin R7 freeze | conformance suite | pinned Robin version probe | 60s | nightly | $0 | quarantine in 24h; blocks R4 |
| ADP-008 black-box tier: final-state-only assertions with stated measurement limits | scenario harness | non-conformant agent script | 90s | gate (`e2e-simulated`) | $0 | ZF; blocks R4 |

### 10.5 Sandbox (`packages/sandbox`, R2)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| SBX-001 fixture materialization via tar stream; workspace matches manifest hash | sandbox harness | `fixtures/repos/materialize/` | 180s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-002 filesystem escape attempts contained; host checkout unreadable | sandbox escape harness | hostile task fixtures | 240s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-003 network-none enforced; host listener observes zero egress | sandbox escape harness | egress-attempt fixtures | 180s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-004 allowlist escape hatch downgrades isolation label in every report | sandbox harness | allowlist task fixture | 120s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-005 CPU/memory/pids/disk limits breach yields `sandbox_limit_exceeded` | sandbox escape harness | exhaustion fixtures | 240s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-006 no ambient credentials; container env equals task-declared set exactly | sandbox harness + canaries | env-probe fixture | 90s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-007 labeled reaping after SIGKILL: next start removes all containers/volumes | crash + sandbox harness | long-running fixture | 240s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-008 archive poisoning (traversal, symlink, hash mismatch) fails before extraction | sandbox harness | poisoned archives | 90s | gate (`sandbox-linux`) | $0 | ZF; blocks R2 |
| SBX-009 `sandbox_unavailable` stable error with no Docker socket; never host exec | integration (socket unset) | none | 30s | gate (`integration`) | $0 | ZF; blocks R2 |
| SBX-010 `--unsafe-host-exec` banner persists through store, report, and viewer | e2e-simulated + viewer | host-exec run fixture | 120s | gate (`e2e-simulated`) | $0 | ZF; blocks R2 |

### 10.6 Providers and usage accounting (`packages/providers`, R3)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| PRV-001 recorded-fixture replay covers every supported dialect happy path | fake provider server | `fixtures/provider/<dialect>/` | 120s | gate (`recorded-provider`) | $0 | ZF; blocks R3 |
| PRV-002 stream faults: truncation, malformed SSE, rate limits, resets classified | fake provider server | fault-schedule fixtures | 120s | gate (`recorded-provider`) | $0 | ZF; blocks R3 |
| PRV-003 usage reconciliation within 1% tokens / $0.01 passes; beyond marks `usage_unreconciled` | fake provider server | disagreeing-usage fixtures | 90s | gate (`recorded-provider`) | $0 | ZF; blocks R3 |
| PRV-004 unreconciled runs fail budget gates closed | fake provider + budgets | unreconciled fixture | 60s | gate (`recorded-provider`) | $0 | ZF; blocks R5 |
| PRV-005 BYOK resolution from env and keychain reference at spawn time only | integration + canaries | synthetic credential refs | 60s | gate (`integration`) | $0 | ZF; blocks R3 |
| PRV-006 credential never persisted: store, logs, reports scanned post-run | planted-credential harness | canary corpus | 90s | gate (`redaction-corpus`) | $0 | ZF; blocks R3 |
| PRV-007 synthetic runs report zero cost with `source: synthetic`, excluded from spend | scenario harness | simulated suite | 30s | gate (`unit-property`) | $0 | ZF; blocks R3 |
| PRV-008 nightly paid smoke: one 3-task suite, n=2, real provider; reconciliation and spend accounting live | live provider (protected env) | fixed public smoke suite | 15m | nightly (`paid-smoke`) | $5/run, enforced by Assay's own suite dollar ceiling; breach aborts and pages owner | quarantine in 24h; blocks R3 release claim |

### 10.7 Trajectory capture and scoring (`packages/trajectory`, R4)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| TRJ-001 lossless capture of the adapter event stream or run marked incomplete | scenario harness | full-event scenarios | 90s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-002 canonical byte-stable trajectory serialization | property-based | seeded event generators | 120s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-003 every trajectory metric against hand-labeled fixture trajectories | unit | `fixtures/trajectories/labeled/` | 90s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-004 loop detection separates principled retry from identical-call loops | unit | retry-vs-loop fixtures | 60s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-005 read-before-write discipline from adapter tool catalog semantics | unit | catalog + trajectory pairs | 60s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-006 trajectory assertions gate on metrics with all comparison operators | scenario harness | metric-gate scenarios | 60s | gate (`trajectory`) | $0 | ZF; blocks R4 |
| TRJ-007 truncation markers on crashed/cancelled runs | crash-injection harness | kill-point scenarios | 180s | gate (`integration`) | $0 | ZF; blocks R4 |
| TRJ-008 metric versioning: definition change bumps version; old runs keep old values | migration-fixture | versioned metric fixtures | 60s | gate (`trajectory`) | $0 | ZF; blocks R4 |

### 10.8 Redaction (`packages/redaction`, R4 capture, R10 bundles)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| RED-001 ruleset detects every planted canary class in every placement | planted-credential harness | generated canary corpus | 120s | gate (`redaction-corpus`) | $0 | ZF; blocks R4 |
| RED-002 entropy scanner catches high-entropy tokens >= 20 chars; bounded false positives on code fixtures | planted-credential harness | entropy corpus + code corpus | 120s | gate (`redaction-corpus`) | $0 | ZF; blocks R4 |
| RED-003 fail-closed: injected redaction fault yields `redaction_failed`, blocks persistence, fails run as infra | fault injection | broken-rule build | 60s | gate (`redaction-corpus`) | $0 | ZF; blocks R4 |
| RED-004 redaction idempotence and stability across ruleset versions | property-based | seeded input generators | 90s | gate (`unit-property`) | $0 | ZF; blocks R4 |
| RED-005 export and support bundles scanned end to end; zero canaries | planted-credential harness | full-store canary fixture | 120s | gate (`redaction-corpus`) | $0 | ZF; blocks R10 |
| RED-006 `assay redact-check <file>` classifies a hostile file correctly | e2e-simulated | hostile file corpus | 30s | gate (`e2e-simulated`) | $0 | ZF; blocks R10 |

### 10.9 Budgets (`packages/budgets`, R5)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| BUD-001 token, wall-clock, tool-call, and dollar budgets each breach independently with exit code 2 | scenario harness | budget-breach scenarios | 90s | gate (`budgets`) | $0 | ZF; blocks R5 |
| BUD-002 budget verdicts use median/p95 across n runs as declared, never single runs | scenario harness | n=10 mixed scenarios | 90s | gate (`budgets`) | $0 | ZF; blocks R5 |
| BUD-003 breach is distinct from assertion failure in report rows and exit codes | scenario harness | combined-failure scenarios | 60s | gate (`budgets`) | $0 | ZF; blocks R5 |
| BUD-004 latency separation: provider vs tool vs harness overhead accounted | scenario harness | timed scenarios (injected clocks) | 60s | gate (`budgets`) | $0 | ZF; blocks R5 |
| BUD-005 runaway-suite guard aborts at projected declared ceiling; `--dry-run` prints matching spend plan | scenario harness | escalating-cost scenarios | 90s | gate (`budgets`) | $0 | ZF; blocks R5 |
| BUD-006 cost-up-quality-flat change fails via suite cost budget | scenario harness | cost-regression pair | 60s | gate (`budgets`) | $0 | ZF; blocks R5 |

### 10.10 Statistics (`packages/stats`, R6)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| STA-001 Wilson, Newcombe, Boschloo/Fisher, BCa bootstrap against published reference values | unit | reference-value tables | 60s | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-002 injected known effects detected at claimed power (seeded subset per PR) | statistical simulation harness | seeded simulation grid | 8m (subset) | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-003 pure-noise false-positive rate within alpha tolerance; BH FDR holds | statistical simulation harness | seeded noise grid | 8m (subset) | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-004 full 1,000-simulation corpus per cell | statistical simulation harness | full seeded grid | 45m | nightly (`stat-full`) | $0 | quarantine in 24h; blocks R6 |
| STA-005 wording contract: only the four permitted phrases, exact trigger conditions | unit + golden | wording fixtures | 30s | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-006 comparison pairing rejects task-content-hash drift with stable error | scenario harness | drifted-suite pair | 60s | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-007 flake classification (always_pass, always_fail, unstable, genuinely unstable) per METHODOLOGY definitions | unit | classification fixtures | 30s | gate (`stat-simulation`) | $0 | ZF; blocks R6 |
| STA-008 mutation score >= 85% on `packages/stats` and `packages/trajectory` | mutation tooling | source under mutation | 40m | gate (`mutation-stats`, main + affected PRs) | $0 | ZF; blocks R6 |

### 10.11 Judge assertions (`packages/judge`, R7)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| JDG-001 loader rejects judge assertions lacking rubric or calibration reference | unit | invalid-judge tasks | 30s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-002 agreement computation (percent, kappa) against hand-computed fixtures | unit | labeled calibration fixtures | 30s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-003 kappa < 0.6 demotes judge to advisory-only in every surface | scenario + recorded judge | low-agreement fixture | 60s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-004 same-family judge rejected unless overridden; override flagged in reports | unit + golden | family-conflict fixtures | 30s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-005 isolation transform: delimiting, provenance labels, instruction stripping | unit adversarial | injection corpus | 60s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-006 red-team manipulation suite via recorded judge responses; detection metrics reported | fake provider server | manipulation task corpus | 180s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |
| JDG-007 k=3 vote majority with stored vote distribution; rubric change invalidates agreement | unit + migration | vote and version fixtures | 60s | gate (`judge-redteam`) | $0 | ZF; blocks R7 |

### 10.12 GitHub Action (`apps/action`, R8)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| ACT-001 real test PR: regression posts delta table and failing check | Action integration harness | injected-regression fixture | 10m | gate (`action-integration`, main + action PRs) | $0 | ZF; blocks R8 |
| ACT-002 idempotent comment update; no duplicates across pushes | Action integration harness | two-push sequence | 8m | gate (`action-integration`) | $0 | ZF; blocks R8 |
| ACT-003 least-privilege token scopes verified; credential absent from logs | Action integration harness | workflow-permission probe | 5m | gate (`action-integration`) | $0 | ZF; blocks R8 |
| ACT-004 fork-PR zero-credential lane runs simulated subjects only | Action integration harness | fork-simulation workflow | 8m | gate (`action-integration`) | $0 | ZF; blocks R8 |
| ACT-005 baseline selection by branch, tag, and stored run id | Action integration harness | baseline matrix fixtures | 8m | gate (`action-integration`) | $0 | ZF; blocks R8 |

### 10.13 Trace store and migrations (`packages/run-store`, R1 and R10)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| STO-001 atomic append; crash at every fault marker leaves committed data intact | crash-injection harness | kill-point schedule | 240s | gate (`store-core`) | $0 | ZF; blocks R1 |
| STO-002 blob content addressing; partial blob never visible under hash name | crash-injection harness | blob write schedule | 120s | gate (`store-core`) | $0 | ZF; blocks R1 |
| STO-003 corruption detected and quarantined, never silently dropped | fault injection | corrupted db/blob fixtures | 90s | gate (`store-core`) | $0 | ZF; blocks R1 |
| STO-004 concurrent parallel-run writers serialize without loss (WAL) | integration | 8-writer stress fixture | 180s | gate (`store-core`) | $0 | ZF; blocks R2 |
| STO-005 forward-only migrations from every old fixture db; explicit `assay db migrate` only | migration-fixture | `fixtures/store/v*/` databases | 120s | gate (`store-core`) | $0 | ZF; blocks R10 |
| STO-006 interrupted migration resumes from durable cursor | crash + migration harness | mid-migration kill points | 180s | gate (`store-core`) | $0 | ZF; blocks R10 |
| STO-007 export bundle self-contained and redacted; deletion removes exactly selected runs | e2e-simulated + canaries | populated store fixture | 120s | gate (`e2e-simulated`) | $0 | ZF; blocks R10 |

### 10.14 Viewer (`apps/viewer`, R9)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| VWR-001 200-turn trajectory renders; p95 < CI ceiling (Section 12) | viewer Playwright harness | 200-turn store fixture | 180s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |
| VWR-002 diff view aligns two runs and locates first divergent turn | viewer Playwright harness | divergent-pair fixture | 120s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |
| VWR-003 read-only: mutating verbs rejected; no mutation endpoint exists | viewer Playwright harness | any store fixture | 60s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |
| VWR-004 loopback-only binding; missing/wrong session token rejected | viewer Playwright harness | any store fixture | 60s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |
| VWR-005 zero external network requests from the SPA | viewer Playwright harness | network-capture run | 60s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |
| VWR-006 axe-core accessibility scan, keyboard navigation of trajectory and diff views | viewer Playwright harness | all routes | 120s | gate (`viewer-regression`) | $0 | ZF; blocks R9 |

### 10.15 Configuration and CLI surface (`packages/config`, `apps/cli`, R0-R1)

| Test | Harness | Fixture | Runtime budget | CI tier (gate/nightly) | Cost ceiling | Flake policy |
| --- | --- | --- | --- | --- | --- | --- |
| CFG-001 precedence flags > env > yaml > defaults with winning-source records | unit | precedence fixtures | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| CFG-002 unknown config keys and unknown `ASSAY_*` variables rejected with positions | unit | invalid-config corpus | 30s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| CFG-003 cold `--help`/`--version` load no sandbox, provider, store, or viewer module | integration (module trace) | none | 30s | gate (`integration`) | $0 | ZF; blocks R0 |
| CFG-004 error-taxonomy stability: every category reachable, stable code and message shape | unit + golden | taxonomy trigger fixtures | 60s | gate (`unit-property`) | $0 | ZF; blocks R1 |
| CFG-005 architecture boundary check: package import rules hold repository-wide | arch tooling | dependency-rule manifest | 60s | gate (`arch-boundaries`) | $0 | ZF; blocks R0 |

## 11. CI Pipeline Definition

### 11.1 Stages and blocking semantics

The pipeline runs on GitHub-hosted runners (Section 2.5) in dependency
order; later stages start only when their prerequisites are green.

| Stage | Job name | Runner | Blocks merge | Contents |
| --- | --- | --- | --- | --- |
| 1 | `typecheck` | ubuntu-24.04 | yes | Strict TypeScript across all workspaces; declaration builds. |
| 1 | `lint-docs` | ubuntu-24.04 | yes | Lint, markdownlint (MD022/MD032 enforced), docs current-vs-planned check (NFR-MAINT-004), wording-contract text audit. |
| 1 | `arch-boundaries` | ubuntu-24.04 | yes | Package dependency-direction rules (NFR-MAINT-001). |
| 2 | `unit-property` | ubuntu-24.04 + macos-14 | yes | Unit and property suites; TF, CFG, ADP contract, RED-004, STA reference values. |
| 3 | `integration` | ubuntu-24.04 + macos-14 | yes | Real-filesystem, store, worker, subprocess suites. |
| 3 | `store-core` | ubuntu-24.04 | yes | STO crash-injection and migration-fixture suites. |
| 4 | `e2e-simulated` | ubuntu-24.04 + macos-14 | yes | Packaged CLI against `adapter-simulated`; byte-reproducibility goldens. |
| 4 | `recorded-provider` | ubuntu-24.04 | yes | PRV recorded-fixture suites through the fake provider server. |
| 4 | `redaction-corpus` | ubuntu-24.04 | yes | RED planted-credential suites. |
| 5 | `sandbox-linux` | ubuntu-24.04 (Docker) | yes | SBX and sandbox-dependent AST/RUN suites, including escape harness. |
| 5 | `budgets` | ubuntu-24.04 | yes | BUD suites. |
| 5 | `trajectory` | ubuntu-24.04 | yes | TRJ suites. |
| 6 | `stat-simulation` | ubuntu-24.04 8-core | yes | STA gate subset: reference values, seeded simulation subset, wording, pairing. |
| 6 | `mutation-stats` | ubuntu-24.04 8-core | yes on main and stats/trajectory PRs | STA-008 mutation run. |
| 6 | `judge-redteam` | ubuntu-24.04 | yes | JDG suites (recorded judges only). |
| 7 | `action-integration` | ubuntu-24.04 (Docker) | yes on main and action PRs | ACT suites against a real test PR. |
| 7 | `viewer-regression` | ubuntu-24.04 | yes on main and viewer PRs | VWR Playwright and accessibility suites. |
| 8 | `package-smoke` | ubuntu-24.04 + macos-14 | yes once packaging exists | Tarball pack, install, `assay --version`, uninstall. |
| n | `stat-full` | ubuntu-24.04 8-core | no (nightly) | STA-004 full 1,000-simulation corpus. |
| n | `paid-smoke` | ubuntu-24.04, protected environment | no (nightly) | PRV-008 with $5 ceiling enforced by Assay's own budget gate. |
| n | `e2e-robin` | ubuntu-24.04 | nightly until R4, then merge-blocking | ADP-006/007 against pinned Robin synthetic. |
| n | `perf-nightly` | ubuntu-24.04 8-core | no (nightly) | Section 12 measurements against CI ceilings. |

Required checks are introduced per gate exactly as listed in Section 3.4.
Fork PRs run stages 1-6 with no secrets; `action-integration` and
`paid-smoke` never run for forks (FR-CI-007).

### 11.2 Caching

- npm cache keyed by lockfile hash; `npm ci --ignore-scripts` always
  verifies integrity against the lock regardless of cache state.
- Build output cache keyed by commit and toolchain versions; the
  `e2e-simulated` job rebuilds from source on main to prevent cache
  poisoning of goldens.
- Sandbox base images pulled by digest and cached on the Docker runner;
  digest pinning (FR-SAND-011) means a cache hit and a fresh pull are
  byte-identical.
- No cache is ever a substitute for evidence: release jobs run from clean
  caches.

### 11.3 Scheduling and retention

- Nightly jobs run from main at a fixed UTC hour; failures page the
  maintainer via GitHub notifications and open labeled issues.
- CI artifacts (goldens diffs, redacted failure bundles, performance
  measurements, evidence manifests) are retained 90 days; gate evidence
  referenced by a release record is retained indefinitely by attaching it
  to the release.
- Workflow definitions are code-reviewed like source; job renames update
  branch protection in the same PR.

## 12. Performance and Cost Budgets

### 12.1 Service-level objectives

SLOs describe the product promise on reference hardware. CI enforces
looser ceilings (12.3) so that runner variance does not create flakes,
while release-candidate measurement on the dedicated 8-core runner must
meet the SLO itself.

| Measure | SLO | Requirement |
| --- | --- | --- |
| Harness overhead per task run, excluding agent and sandbox-image time | p95 < 2s | NFR-COST-005 |
| Viewer render of a 200-turn trajectory from the local store | p95 < 1s | NFR-COST-006 |
| Suite of 50 tasks x n=10 against the simulated adapter | completes < 15 min on an 8-core runner | R10 acceptance |
| Required-CI provider spend | $0 | NFR-COST-001 |
| Nightly paid smoke spend | <= $5 per run, enforced by Assay's own suite dollar ceiling | NFR-COST-002 |

### 12.2 Measurement method

- Harness overhead is measured by the runner's own latency accounting
  (FR-BUD-006): per task run, total wall time minus agent time minus
  sandbox image-pull time, on the reference simulated suite with warm
  images; p95 over 500 task runs; the measurement uses production
  accounting code, so the measurement itself is regression-tested.
- Viewer latency is measured by the Playwright harness as
  navigation-to-render-complete against the checked-in 200-turn fixture,
  p95 over 50 loads on the 8-core runner.
- Suite throughput is measured end to end with `assay run` on the
  50-task reference suite at the default concurrency; the evidence
  records runner class, image versions, and concurrency.
- Spend is measured by Assay's own reconciled usage accounting
  (ADR-0009); the paid smoke's evidence includes provider-reported and
  catalog-derived numbers and their reconciliation verdict, making the
  cost pipeline self-demonstrating.
- Every performance evidence record names dataset version, runner class,
  commit, and raw percentile values; single-machine numbers are never
  generalized in documentation.

### 12.3 CI ceilings

| Measure | CI ceiling | Rationale |
| --- | --- | --- |
| Harness overhead p95 | < 3s | Runner variance headroom over the 2s SLO. |
| Viewer 200-turn render p95 | < 1.5s | Headroom over the 1s SLO. |
| 50-task x n=10 simulated suite | < 20 min | Headroom over the 15 min SLO. |
| `unit-property` job wall time | < 10 min | Keeps the PR loop fast. |
| Full merge-blocking pipeline | < 45 min | Latency budget for the required lane. |
| `stat-full` nightly | < 60 min | Full simulation corpus budget. |
| `paid-smoke` | <= $5, aborts via runaway guard | NFR-COST-002; a guard abort is a failed run and an incident (Section 17.4). |

A CI-ceiling breach on main is treated as a regression: the offending
change is identified and reverted or fixed forward within the flake-policy
window. SLO verification happens at each release candidate on the
dedicated runner and is recorded in the release evidence.

## 13. Packaging and Release Pipeline

### 13.1 Artifacts

A release produces, from one commit and one CI run:

- the `assay` npm package (CLI plus bundled viewer assets, esbuild
  output, exact-pinned production dependencies);
- a container image for CI use, tagged by version and pinned by digest in
  documentation;
- the GitHub Action (`apps/action`), versioned and tagged for
  `uses: Zachshotamartin/Assay/action@vX` consumption;
- SBOMs for package and image;
- provenance attestations from the isolated release job;
- a checksums file signed by the release key;
- the compatibility record of Section 2.6.

### 13.2 Reproducible build

- The build runs `npm ci --ignore-scripts` from the committed lock on a
  pinned runner image and pinned Node patch version.
- esbuild inputs are fully pinned; the bundle embeds the version and
  commit; timestamps are normalized so two builds of the same commit
  produce byte-identical tarballs.
- A verification job rebuilds from the tag in a separate clean workspace
  and compares artifact hashes before publish proceeds.

### 13.3 GitHub Action packaging

The Action is a first-class released artifact with its own contract:

- versioning: the Action ships from the release tag; a moving `v1` major
  tag is updated only by release automation and only to a signed release
  commit; consumers pinning by SHA are documented as the hardened option;
- permission scopes: the Action documents and requests only
  `contents: read`, `pull-requests: write` (comment), and
  `statuses: write` (check); each scope maps to a named feature, and
  ACT-003 verifies no additional scope is required or used (FR-CI-004,
  NFR-SEC-008);
- inputs are versioned and schema-validated like every other public
  contract (NFR-MAINT-003); unknown inputs fail the workflow;
- provider credentials reach the Action only via GitHub secrets and are
  never logged (FR-CI-005); fork PRs get the zero-credential lane
  (FR-CI-007).

### 13.4 Version and tag flow

1. Merge the release PR (changelog, version bump, compatibility record).
2. Tag `vX.Y.Z-rc.N` via authenticated `gh release create --prerelease`;
   the release-candidate workflow runs the full matrix plus packaging,
   installation, migration, and performance evidence.
3. Approve the release environment (separate from merge approval).
4. Tag `vX.Y.Z`; the publish job uploads npm package, image, Action tag,
   SBOMs, provenance, and signed checksums to the same release ID.
5. Verify the published npm package and image in a clean job by digest
   and checksum before announcing.

Every step that touches GitHub runs through the authenticated `gh` CLI
established in Section 4.1. A tag is never moved; a bad release is
superseded by a patch.

## 14. Installation, First Run, Update, Rollback, Uninstall, Purge

### 14.1 Installation

1. `npm install -g assay` (or `npx assay` for one-shot use; the container
   image serves CI).
2. `assay --version` prints the installed version and commit.
3. `assay doctor` reports platform tier, container runtime status, and
   achieved sandbox capability.

Guarantees: installation writes only the npm global prefix; it creates no
`.assay/` store, no global state beyond `~/.assay/cache/` (created lazily,
not at install), and contacts no endpoint beyond the npm registry fetch
itself.

### 14.2 First run

1. `assay init` in a project: creates `.assay/` (Section 6.1), writes a
   commented starter `assay.config.yaml`, and appends `.assay/` to
   `.gitignore`.
2. `assay validate` on the starter suite passes without a container
   runtime or credential.
3. `assay run examples/smoke.suite.yaml --variant baseline --adapter
   simulated -n 5` completes with zero spend and produces a scored,
   byte-reproducible result.
4. `assay view` renders the run locally.

Guarantees: first run requires no credential, no container runtime (the
simulated adapter runs sandboxed only when a runtime exists; the starter
suite declares the simulated adapter's no-sandbox profile), and no network
egress.

### 14.3 Update

1. `npm update -g assay` (or bump the pinned Action/image version).
2. On first store access, a schema-version mismatch fails with
   `storage_migration_required` naming the exact command.
3. `assay db migrate` runs the forward-only migration explicitly: it
   backs up `assay.db` to `assay.db.pre-<schemaversion>` inside
   `.assay/`, migrates, verifies row counts and spot hashes, then reports
   the backup path and retention guidance. Migration never runs
   implicitly on read (FR-TRACE-006, ADR-0008).

Guarantees: an interrupted migration resumes from its durable cursor
(STO-006); old runs keep old metric values (FR-TRAJ-008); the pre-migration
backup is preserved until the user deletes it.

### 14.4 Rollback

Rollback is binary rollback plus a restore path, because migrations are
forward-only by decision (ADR-0008) — there is no down-migration code to
mis-trust:

1. `npm install -g assay@<previous>` restores the previous binary.
2. If the store was migrated, the old binary refuses the new schema with
   `storage_migration_required` (unknown newer version). Restore the
   store from the automatic pre-migration backup:
   copy `.assay/assay.db.pre-<schemaversion>` over `.assay/assay.db`.
3. Runs recorded after the migration exist only in the newer store; the
   restore message states exactly which run IDs are in the newer file so
   nothing is silently lost. Keeping both files side by side is supported;
   nothing deletes the newer store during rollback.

### 14.5 Uninstall (data-preserving)

1. `npm uninstall -g assay`.
2. Project `.assay/` stores and `assay.config.yaml` files remain
   untouched — they are the user's data, in the user's repositories.
3. `~/.assay/cache/` remains and may be deleted manually at any time.

### 14.6 Purge (full removal)

1. Per project: `assay delete --all` (while installed) or `rm -rf
   .assay/` after reviewing `assay export` needs; remove
   `assay.config.yaml` and the `.gitignore` line if desired.
2. Global: remove `~/.assay/cache/`.
3. Sandbox residue: `assay gc` (while installed) removes labeled
   containers and volumes; after uninstall, the documented manual
   equivalent is a `docker ps -a --filter label=assay` / `docker volume
   ls --filter label=assay` review and removal.

Purge guarantees: every Assay-owned location is enumerated above; Assay
writes nowhere else, so this list is complete by construction and verified
by the packaging file-inventory test and the doctor's location report.

## 15. Diagnostics

### 15.1 `assay doctor` check categories

`assay doctor` is read-only and reports, with an exact remediation pointer
per failure:

1. platform: OS, version, architecture, tier per Section 2.2; native
   Windows detection with WSL2 guidance;
2. toolchain: Node and npm versions against the supported matrix;
3. container runtime: name, version, socket path, rootless status,
   capability probe results, achieved sandbox tier (Section 2.4); the
   probe container is labeled and removed;
4. store: location, permissions, schema version, migration state, blob
   directory integrity spot check, quarantined-record count;
5. configuration: effective values with winning sources; unknown-key and
   unknown-`ASSAY_*` findings; secret-shaped values redacted;
6. credentials: which references (env names, keychain items) resolve,
   values never displayed;
7. adapters: discovered adapter binaries, contract versions, conformance
   tiers; pinned Robin version match for `adapter-robin`;
8. disk: free space against store-growth and sandbox-scratch thresholds;
9. residue: labeled containers or volumes that `assay gc` would reap.

The doctor never installs, repairs, mutates configuration, or contacts a
provider.

### 15.2 Structured logs

- Logs are line-delimited JSON to stderr (human-readable rendering on a
  TTY), with stable event names drawn from the `AssayEvent` union and the
  error taxonomy.
- Every log line passes the capture-boundary redaction pass before
  emission — the same code path as trace persistence, so the planted-
  credential corpus covers logs for free.
- Log verbosity is a flag/env setting; no level logs credential values,
  full trajectory payloads, or fixture contents.

### 15.3 Support bundle

`assay export --support <run-id>` builds a redacted support bundle with
enumerated contents, printed before writing:

1. harness version, commit, platform, and doctor report;
2. effective configuration with winning sources, secret-shaped values
   redacted;
3. the selected run's record, event sequence, and assertion results;
4. trajectory records for the selected run (already capture-redacted);
5. store schema version and migration history;
6. the error taxonomy classification and stderr tail for the failure,
   redacted.

Excluded always: credentials, keychain contents, environment values,
fixture archives, unrelated runs, and anything outside the enumerated
list. The bundle is written only after the planted-credential scanner
passes over the assembled bytes; a scanner hit aborts the bundle with
`redaction_failed`. RED-005 is the release test for this path, and the
bundle-content enumeration is itself a golden fixture so silent content
growth fails CI (NFR-PRIV-004).

## 16. Retention, Export, and Deletion Mechanics

Policy (what is kept, why, and the user's rights) is owned by
PRIVACY_AND_DATA.md. This section owns the mechanics that any policy value
executes through.

- Retention: `retention` in `assay.config.yaml` configures maximum run age
  and count per project; the documented default is keep-everything-local
  (FR-TRACE-010). Enforcement runs only during explicit `assay gc`, which
  prints the exact run IDs it will remove and removes runs and their
  now-unreferenced blobs transactionally.
- Export: `assay export <run...>` produces a self-contained bundle (run
  records, trajectories, blobs, schema version) that `assay view` can open
  read-only; export re-runs the redaction scanner over assembled bytes
  even though inputs were capture-redacted, as defense in depth
  (FR-TRACE-007).
- Deletion: `assay delete <run...>` removes exactly the selected runs:
  rows, their trajectory records, and blobs no longer referenced by any
  remaining run. It prints the inventory first, requires confirmation
  (or `--yes`), reports partial failure per item, and never touches
  fixtures, configuration, or anything outside `.assay/` (FR-TRACE-007).
- Blob reference counting is computed from the live database at deletion
  time, never from a cached index, so deletion cannot orphan a referenced
  blob or strand an unreferenced one silently; STO-007 is the evidence.

## 17. Incident Response

Every incident produces a record: timeline, blast radius, root cause,
remediation, and the regression test that now prevents recurrence.

### 17.1 Leaked credential

1. Rotate the affected credential immediately at the provider; assume
   compromise from the moment of exposure.
2. Determine the exposure surface: because redaction is capture-boundary
   and fail-closed, a leak implies either a redaction-rule gap or an
   out-of-band path; run `assay redact-check` and the planted-credential
   corpus against a canary shaped like the leaked value.
3. Scrub check: scan the store, exports, CI artifacts, and Git history
   for the leaked value; document every location and its remediation
   (deletion, history rewrite request, artifact expiry).
4. Add the leaked value's shape to the redaction ruleset with a corpus
   test in the same PR; a ruleset version bump follows ADR-0010.
5. File the incident record; the R-gate evidence for the affected release
   notes the incident and its closure.

### 17.2 Poisoned fixture

1. Quarantine by hash: add the fixture archive's content hash to the
   store-level quarantine list so no run can materialize it
   (`fixture_unavailable` with the quarantine reason).
2. Identify how it entered: fixture-governance review (Section 3.6)
   failure, generator defect, or malicious contribution.
3. Re-verify the corpus: re-hash every fixture against its manifest, and
   re-run the sanitization pass over recorded-provider fixtures.
4. Land a regression: the poison technique becomes a new SBX-008 or
   fixture-governance test case.
5. Invalidate results: runs that materialized the poisoned fixture are
   marked quarantined in the store, and any comparison that included them
   is flagged in the viewer and reports.

### 17.3 Sandbox escape report

1. Treat as severity-critical until scoped; the defended boundary and
   exclusions are those of ADR-0004 and THREAT_MODEL.md.
2. Reproduce inside the escape harness; a reproducible escape within the
   defended boundary halts release publication and demotes the R2 claim
   to in progress until fixed.
3. If the escape is outside the defended boundary (kernel or daemon
   compromise), document it as such and update THREAT_MODEL.md wording if
   the boundary statement was unclear.
4. Disclosure: private vulnerability reporting is the intake (Section
   3.7); fixes ship as a patch release with an advisory crediting the
   reporter; details publish after the fix is available.
5. The escape technique becomes a permanent SBX suite case.

### 17.4 Runaway spend

1. The runaway-suite guard (FR-BUD-008, NFR-COST-004) is the kill switch:
   it aborts the suite at the declared dollar ceiling, fail-closed. A
   guard trigger in `paid-smoke` is automatically an incident.
2. Verify the abort: confirm from provider-side usage that spend stopped
   at or under the ceiling plus one in-flight request.
3. Postmortem the guard: why did projected spend approach the ceiling —
   pricing catalog drift, reconciliation gap, adapter usage misreport, or
   suite misconfiguration? The postmortem must state whether the guard
   fired at the correct projection point.
4. If provider-side spend exceeded the harness's accounting, that is an
   ADR-0009 reconciliation defect: file it as a correctness bug against
   the cost pipeline, not merely an operations note.
5. Adjust ceilings only through reviewed configuration changes; never
   raise a ceiling to make an incident disappear.

## 18. Release Gates R0-R10

BUILD_PLAN.md defines the feature work and ticket sequencing for each
gate; this section defines the operational evidence that closes it. A
later gate inherits every earlier gate's suites as regression coverage. A
gate's commands must all be green from the same commit.

### 18.1 R0 — Repository, toolchain, and CI identity

Evidence commands and checks:

```bash
gh auth status
gh api user --jq .login
git remote get-url origin
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run test:unit
```

R0 passes when:

- `gh auth status` and the `gh api user` probe verify the authenticated
  account, and the R0 record names it (ticket R0.01; Section 4.1);
- the canonical repository exists at
  `https://github.com/Zachshotamartin/Assay.git`, created and protected
  through the authenticated `gh` CLI, with the Section 3.4 initial
  required checks (`typecheck`, `lint-docs`, `unit-property`,
  `arch-boundaries`) enforced on `main`;
- the npm-workspaces monorepo matches the fixed repository layout, and
  CFG-005 architecture-boundary checks pass (NFR-MAINT-001);
- clean-clone bootstrap (Section 4.2-4.3) passes on Tier 1 macOS and
  Linux from one commit (NFR-MAINT-006);
- the docs check enforces current-versus-planned separation and the
  verbatim current-baseline claim (NFR-MAINT-004);
- dependency intake records exist for every runtime dependency present
  (NFR-SEC-006);
- CFG-003 proves cold `--help`/`--version`.

### 18.2 R1 — Task format, runner, and deterministic assertions

Evidence commands:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e:simulated
node apps/cli/dist/bin.js validate fixtures/suites/reference
node apps/cli/dist/bin.js run fixtures/suites/reference.suite.yaml \
  --variant baseline --adapter simulated -n 10 --seed 42
```

R1 passes when:

- TF-001 through TF-009, RUN-001 through RUN-007, RUN-010, AST-001
  through AST-003, AST-005, AST-006, ADP-001 through ADP-004, STO-001
  through STO-003, CFG-001, CFG-002, and CFG-004 are green;
- the reference suite run against the simulated agent is byte-reproducible
  across two runs and across macOS/Linux (RUN-004, RUN-005; NFR-DET-004);
- contract tests pin the documented seven-outcome mapping, and subprocess
  tests produce the five R1-reachable outcomes 0, 1, 4, 5, and 6
  (FR-RUN-010, ADR-0015); exit 2 is proved by R5 BUD-001/BUD-003 and exit 3
  by the R6 comparison evidence;
- `e2e-simulated` and `store-core` join the required checks;
- required CI spends $0 and calls no live provider (NFR-COST-001,
  NFR-DET-001); all randomness is seeded and recorded (NFR-DET-002,
  NFR-DET-003);
- golden regeneration runs only through the explicit command with
  semantic review (NFR-MAINT-005).

### 18.3 R2 — Sandboxed execution

Evidence commands:

```bash
npm run test:sandbox
node apps/cli/dist/bin.js run fixtures/suites/sandboxed.suite.yaml \
  --variant baseline --adapter simulated -n 5
node apps/cli/dist/bin.js gc
docker ps -a --filter label=assay --format '{{.ID}}'   # must be empty
```

R2 passes when:

- SBX-001 through SBX-010, RUN-008, RUN-009, AST-004, AST-007, AST-008,
  and STO-004 are green on the Docker-enabled Linux runner;
- the escape harness proves filesystem, network, process, resource, and
  fixture-poisoning containment (FR-SAND-007, NFR-SEC-002, NFR-SEC-007);
- a `SIGKILL`ed run leaves the store recoverable and every labeled
  container reapable on next start (FR-RUN-011, FR-SAND-006);
- `sandbox_unavailable` is proven stable with no runtime present, and
  `--unsafe-host-exec` banners persist end to end (FR-SAND-009,
  FR-SAND-010);
- `sandbox-linux` joins the required checks;
- harness-overhead measurement machinery exists and reports against the
  Section 12.3 CI ceiling (NFR-COST-005 begins; terminal at R2 per the
  requirement register).

### 18.4 R3 — Real providers, BYOK, and usage accounting

Evidence commands:

```bash
npm run test:recorded-provider
npm run test:redaction
gh workflow run paid-smoke.yml --ref main   # nightly lane, $5 ceiling
```

R3 passes when:

- PRV-001 through PRV-007 are green in required CI using recorded
  fixtures only (NFR-DET-006);
- one `paid-smoke` nightly run has completed with reconciled usage,
  provider-vs-catalog agreement within 1% tokens / $0.01, and total
  spend <= $5 enforced by Assay's own budget gate (NFR-COST-002);
- BYOK resolution is spawn-time-only from env/keychain references, with
  the planted-credential corpus proving nothing persisted (NFR-SEC-004,
  PRV-005, PRV-006);
- per-provider egress documentation is complete and accurate
  (NFR-PRIV-005, NFR-PRIV-001);
- `recorded-provider` joins the required checks;
- the adapter contract carries model identity, usage, and cost per model
  request (FR-ADAPT-008).

### 18.5 R4 — Trajectory capture and scoring

Evidence commands:

```bash
npm run test:trajectory
npm run test:e2e:robin
npm run test:redaction
```

R4 passes when:

- TRJ-001 through TRJ-008, ADP-005, ADP-006, ADP-008, RED-001 through
  RED-004 are green;
- trajectory capture is proven identical for simulated, Robin-synthetic,
  and recorded-provider runs (FR-TRAJ-012);
- the Robin-synthetic e2e lane runs deterministically and free against
  the pinned Robin version (NFR-DET-005), with the adapter's
  pinned-preview conformance tier reported (ADR-0005);
- every trajectory record is redacted at capture, fail-closed
  (FR-TRAJ-007, NFR-PRIV-002);
- `trajectory`, `redaction-corpus`, and `e2e-robin` join the required
  checks;
- traceability rows for the FR-TRAJ namespace are complete in Section 19.

### 18.6 R5 — Budget gates

Evidence commands:

```bash
npm run test:budgets
node apps/cli/dist/bin.js run fixtures/suites/budgeted.suite.yaml \
  --variant expensive --adapter simulated -n 10 ; echo "exit=$?"  # expect 2
node apps/cli/dist/bin.js run fixtures/suites/budgeted.suite.yaml \
  --variant baseline --dry-run
```

R5 passes when:

- BUD-001 through BUD-006 and PRV-004 are green;
- a run exceeding a declared token, time, call-count, or dollar threshold
  fails with exit code 2 and a distinct report row (FR-BUD-001,
  FR-BUD-002);
- budget verdicts use reconciled usage and the declared median/p95
  summary across runs (FR-BUD-003, FR-BUD-004);
- `--dry-run` prints the resolved plan with the estimated spend ceiling
  computed by the published cost model (FR-RUN-012, NFR-COST-003);
- the runaway guard aborts at the declared suite ceiling in a scenario
  test (FR-BUD-008, NFR-COST-004);
- `budgets` joins the required checks.

### 18.7 R6 — Statistical comparison

Evidence commands:

```bash
npm run test:stats
npm run test:stats:simulation           # seeded PR subset
npm run test:mutation                   # stats + trajectory packages
node apps/cli/dist/bin.js compare fixtures/store/baseline-run \
  fixtures/store/regressed-run --threshold 0.05 ; echo "exit=$?"  # expect 3
```

R6 passes when:

- STA-001 through STA-008 are green, including a completed nightly
  `stat-full` corpus of 1,000 seeded simulations per cell;
- an injected known regression is detected and pure injected noise does
  not fire beyond the alpha tolerance (FR-STAT-008);
- every comparing surface shows rates with Wilson intervals, named tests
  with raw and BH-adjusted values, the bootstrap seed, and the MDE for
  the actual n (FR-STAT-002, FR-STAT-003, FR-STAT-004, FR-STAT-005,
  FR-STAT-009);
- only the four permitted wording-contract phrases are emitted
  (FR-STAT-007), and n < 5 always reads insufficient data;
- the comparison subprocess returns exit code 3 for `regression detected`
  and returns no other verdict as code 3 (FR-RUN-010, ADR-0015);
- mutation score >= 85% on `packages/stats` and `packages/trajectory`
  (NFR-MAINT-002);
- the METHODOLOGY power/MDE tables are generated by the shipped code and
  diffed in CI (FR-STAT-012);
- `stat-simulation` and `mutation-stats` join the required checks.

### 18.8 R7 — Judge assertions and red-team

Evidence commands:

```bash
npm run test:judge
node apps/cli/dist/bin.js judge calibrate fixtures/judge/reference-rubric.yaml
```

R7 passes when:

- JDG-001 through JDG-007 are green with recorded judge responses in
  required CI;
- calibration against the >= 50-item labeled set computes percent
  agreement and kappa, stores them per rubric version x judge model, and
  the kappa >= 0.6 gate demotes low-agreement judges to advisory
  (FR-JUDGE-002, FR-JUDGE-003, FR-JUDGE-004);
- the manipulation red-team suite passes with detection metrics reported
  (FR-JUDGE-007, NFR-SEC-003) and the isolation transform survives the
  injection corpus (FR-JUDGE-006);
- judge calls are cost-accounted and budget-gated like any provider call
  (FR-JUDGE-008), with k=3 majority votes stored (FR-JUDGE-009);
- `judge-redteam` joins the required checks.

### 18.9 R8 — CI integration

Evidence commands:

```bash
npm run test:action        # drives the Action integration harness
gh pr view <test-pr> --json statusCheckRollup,comments
```

R8 passes when:

- ACT-001 through ACT-005 are green against a real test PR in the
  canonical repository, created and torn down via the authenticated `gh`
  established at R0.01;
- a threshold breach blocks the test PR via a failing status check, and
  the idempotently-updated comment carries the delta table with
  confidence intervals (FR-CI-001, FR-CI-002, FR-CI-003, FR-CI-006);
- token scopes are least-privilege and documented per feature (FR-CI-004)
  and credentials never appear in workflow logs (FR-CI-005);
- the fork-PR zero-credential lane runs simulated subjects only
  (FR-CI-007);
- `action-integration` joins the required checks;
- soft-launch marketing assets may begin production per MARKETING.md
  sequencing, with every claim mapped to accepted-gate evidence.

### 18.10 R9 — Trace store and viewer

Evidence commands:

```bash
npm run test:viewer
node apps/cli/dist/bin.js view --port 0   # manual spot check on fixtures
```

R9 passes when:

- VWR-001 through VWR-006 and SBX-010's viewer banner leg are green;
- two runs of one task render, diff, and the first divergent turn is
  located (FR-TRACE-004, FR-TRACE-005, FR-TRAJ-011);
- the viewer is loopback-bound, token-authenticated, read-only, and makes
  zero external requests (FR-TRACE-008, NFR-SEC-005, ADR-0011);
- the 200-turn render meets the CI ceiling, with the SLO measured at the
  release candidate (NFR-COST-006);
- store list/get/compare queries used by reports and viewer are covered
  (FR-TRACE-002);
- `viewer-regression` joins the required checks.

### 18.11 R10 — Packaging, operations, and 1.0

Evidence commands:

```bash
npm run release:candidate       # full matrix + packaging + performance
npm pack --dry-run              # file-inventory allowlist check
gh release create v1.0.0-rc.1 --prerelease --verify-tag
gh release create v1.0.0 --verify-tag
```

R10 passes when:

- every earlier gate's suites are green from the release-candidate
  commit on every Tier 1 cell, and the flake ledger is empty for
  required suites;
- packaging produces the npm package, container image, Action tag,
  SBOMs, provenance, and signed checksums, reproducibly verified in a
  clean job (Section 13; NFR-SEC-008);
- install, first run, update with `assay db migrate`, rollback with
  backup restore, uninstall, and purge each pass their scripted
  lifecycle checks on clean Tier 1 machines (Section 14; FR-TASK-011,
  FR-TRACE-006 via STO-005/STO-006);
- export, deletion, retention mechanics, and the redacted support bundle
  pass RED-005, RED-006, and STO-007 (FR-TRACE-007, FR-TRACE-010,
  NFR-PRIV-003, NFR-PRIV-004);
- the planted-credential corpus passes over every artifact class,
  closing NFR-SEC-001;
- every public contract is versioned (NFR-MAINT-003) and no telemetry
  exists (NFR-PRIV-006);
- performance SLOs of Section 12.1 are met on the dedicated runner,
  including the 50-task x n=10 suite under 15 minutes;
- a public result set produced by the released binary is published with
  the release;
- the marketing claim audit passes: every MARKETING.md and README claim
  maps to an accepted gate's evidence;
- the requirement-to-evidence validator confirms Section 19 is complete
  and every row's suites exist and passed on the release commit.

## 19. Requirement-to-Evidence Traceability

The tables below are the auditable registry for this plan: all 148
normative IDs from PRODUCT_REQUIREMENTS.md, each mapped to its evidence
suites (Section 10 test families) and the gate whose acceptance evidence
terminally proves it. Earlier gates may begin a requirement; the owning
gate closes it. When the machine-readable mirror is implemented, its
validator must prove a bijection with these rows and resolve every named
suite in the same commit's evidence record.

### 19.1 FR-TASK — task and suite format

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-TASK-001 | R1 | TF-001, TF-002 | Schema validation precedes any run; invalid tasks never execute. |
| FR-TASK-002 | R1 | TF-001, TF-002 | Every declared field accepted; unknown fields rejected with key paths. |
| FR-TASK-003 | R1 | TF-009 | Hostile YAML is inert at parse time; no execution during load. |
| FR-TASK-004 | R1 | TF-003 | Inheritance merge rules and cycle rejection hold on the fixture corpus. |
| FR-TASK-005 | R1 | TF-004 | Matrix expansion is deterministic with stable instance ids under generation. |
| FR-TASK-006 | R1 | TF-005 | Path/tag selection ordering is deterministic across platforms. |
| FR-TASK-007 | R1 | TF-006 | Unknown format majors rejected with the stable error. |
| FR-TASK-008 | R2 | SBX-001, SBX-008 | Fixtures resolve content-addressed with no load-time network fetch. |
| FR-TASK-009 | R2 | SBX-003, SBX-004, SBX-006 | Default-none network and explicit credential declarations enforced. |
| FR-TASK-010 | R1 | TF-008 | `assay validate` validates everything and runs nothing. |
| FR-TASK-011 | R10 | TF-010 | Old-version task fixtures migrate via explicit command; never silently rewritten. |
| FR-TASK-012 | R1 | TF-007 | Task ids proven safe as filesystem and DB keys under generation. |

### 19.2 FR-RUN — runner and lifecycle

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-RUN-001 | R1 | RUN-001, RUN-004 | `assay run` executes a suite for one variant at declared n. |
| FR-RUN-002 | R1 | RUN-001, RUN-002 | State machine walked; illegal transitions are `internal_invariant`. |
| FR-RUN-003 | R1 | RUN-003 | Infrastructure error never scored as task failure. |
| FR-RUN-004 | R1 | RUN-004, RUN-005 | Byte-identical scored results for fixed inputs on both Tier 1 platforms. |
| FR-RUN-005 | R2 | RUN-009 | Bounded concurrency; no cross-run trajectory interleaving. |
| FR-RUN-006 | R2 | RUN-008 | SIGINT/SIGTERM reap subprocesses and sandboxes; `cancelled` persisted. |
| FR-RUN-007 | R1 | RUN-010 | Run record binds all content hashes, identities, seeds, versions. |
| FR-RUN-008 | R2 | SBX-005, RUN-008 | Per-task and per-suite timeouts from harness monotonic clocks. |
| FR-RUN-009 | R1 | RUN-006 | Reruns append; prior records bit-identical afterward. |
| FR-RUN-010 | R1 | RUN-007 | All seven exit codes produced by forcing scenarios. |
| FR-RUN-011 | R2 | SBX-007, STO-001 | Killed harness leaves store recoverable and sandboxes reapable. |
| FR-RUN-012 | R5 | BUD-005 | `--dry-run` prints the resolved plan and spend ceiling, side-effect free. |

### 19.3 FR-ASSERT — layered assertions

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-ASSERT-001 | R1 | AST-001 | Every deterministic assertion type verified against known workspaces. |
| FR-ASSERT-002 | R1 | AST-002 | Deterministic -> checker -> judge layering enforced at load. |
| FR-ASSERT-003 | R1 | AST-003 | Checker workers run with time and memory limits. |
| FR-ASSERT-004 | R1 | AST-003 | Checker crash/timeout is assertion error, not failure. |
| FR-ASSERT-005 | R1 | AST-005 | Result records carry type, target, observed, expectation, verdict, duration. |
| FR-ASSERT-006 | R7 | JDG-001 | Loader rejects judge assertions lacking rubric or calibration. |
| FR-ASSERT-007 | R7 | JDG-003, JDG-004 | Agreement metadata accompanies every judged verdict surface. |
| FR-ASSERT-008 | R2 | AST-008 | Assertions see only the workspace snapshot, never host state. |
| FR-ASSERT-009 | R1 | AST-006 | `diff_matches` follows TASK_FORMAT matching rules on the patch corpus. |
| FR-ASSERT-010 | R2 | AST-007 | `tests_pass` parses exit status only, inside the sandbox. |

### 19.4 FR-TRAJ — trajectory capture and scoring

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-TRAJ-001 | R4 | TRJ-001 | Full request/tool/timing/token/cost capture on full-event scenarios. |
| FR-TRAJ-002 | R4 | TRJ-002 | Canonical serialization byte-stable under generation. |
| FR-TRAJ-003 | R4 | TRJ-003 | All metrics match hand-labeled fixture trajectories. |
| FR-TRAJ-004 | R4 | TRJ-006 | Trajectory assertions gate on metrics with all operators. |
| FR-TRAJ-005 | R4 | TRJ-001 | Lossy capture marks the run incomplete. |
| FR-TRAJ-006 | R4 | TRJ-004 | Retry-after-new-information distinguished from identical-call loops. |
| FR-TRAJ-007 | R4 | RED-001, RED-003 | Capture-boundary redaction, fail-closed, before persistence. |
| FR-TRAJ-008 | R4 | TRJ-008 | Metric version bump; old runs keep old values. |
| FR-TRAJ-009 | R4 | TRJ-007 | Truncation markers on crashed/cancelled runs. |
| FR-TRAJ-010 | R4 | TRJ-005, ADP-005 | Read-before-write from adapter tool-catalog semantics. |
| FR-TRAJ-011 | R9 | VWR-002 | Turn alignment keys drive the divergence-locating diff. |
| FR-TRAJ-012 | R4 | TRJ-001, ADP-006, PRV-001 | Identical capture across simulated, Robin-synthetic, recorded-provider runs. |

### 19.5 FR-BUD — budget gates

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-BUD-001 | R5 | BUD-001 | All four budget kinds declarable per task and suite; each breaches independently. |
| FR-BUD-002 | R5 | BUD-003 | Breach distinct from assertion failure: exit code 2, own report row. |
| FR-BUD-003 | R5 | PRV-004 | Unreconciled usage fails budget gates closed. |
| FR-BUD-004 | R5 | BUD-002 | Verdicts use declared median/p95 across n runs, never single runs. |
| FR-BUD-005 | R5 | BUD-006 | Cost-up-quality-flat change fails via suite cost budget. |
| FR-BUD-006 | R5 | BUD-004 | Provider, tool, and harness latency separated in accounting. |
| FR-BUD-007 | R2 | SBX-005 | Hard kill limits enforced in the sandbox independent of accounting. |
| FR-BUD-008 | R5 | BUD-005 | Runaway guard aborts at the declared suite ceiling. |

### 19.6 FR-STAT — statistical comparison

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-STAT-001 | R6 | STA-005, RUN-004 | Every comparing surface reports rates over n, never single-run booleans. |
| FR-STAT-002 | R6 | STA-001, STA-005 | Wilson 95% intervals render everywhere rates render. |
| FR-STAT-003 | R6 | STA-001, STA-005 | ADR-0006 tests named in reports with p/q values shown. |
| FR-STAT-004 | R6 | STA-003 | BH FDR at q=0.05 holds; raw and adjusted values both shown. |
| FR-STAT-005 | R6 | STA-002, STA-005 | MDE for the actual n stated in every report. |
| FR-STAT-006 | R6 | STA-007 | Flake classes computed per METHODOLOGY definitions. |
| FR-STAT-007 | R6 | STA-005 | Only the four permitted phrases, with exact trigger conditions. |
| FR-STAT-008 | R6 | STA-002, STA-003, STA-004 | Injected effects detected; noise does not fire; full corpus nightly. |
| FR-STAT-009 | R6 | STA-001 | Seeded stratified bootstrap; seed recorded in the report. |
| FR-STAT-010 | R6 | STA-006 | Content-hash drift aborts comparisons with the stable error. |
| FR-STAT-011 | R6 | STA-002, RUN-004 | Variant matrix produces one comparison report across dimensions. |
| FR-STAT-012 | R6 | STA-002 | METHODOLOGY power/MDE tables generated by shipped code, diffed in CI. |

### 19.7 FR-JUDGE — judge assertions

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-JUDGE-001 | R7 | JDG-001 | Rubric file required and referenced by the task. |
| FR-JUDGE-002 | R7 | JDG-002 | >= 50 labeled items with documented provenance. |
| FR-JUDGE-003 | R7 | JDG-002 | Agreement and kappa stored per rubric version x judge model. |
| FR-JUDGE-004 | R7 | JDG-003 | kappa >= 0.6 required to gate; below is advisory-only everywhere. |
| FR-JUDGE-005 | R7 | JDG-004 | Cross-family default; override flagged in every report. |
| FR-JUDGE-006 | R7 | JDG-005 | Isolation transform survives the injection corpus. |
| FR-JUDGE-007 | R7 | JDG-006 | Red-team manipulation suite in CI with reported detection metrics. |
| FR-JUDGE-008 | R7 | JDG-006, BUD-001 | Judge calls cost-accounted and budget-gated. |
| FR-JUDGE-009 | R7 | JDG-007 | k=3 majority with stored vote distributions. |
| FR-JUDGE-010 | R7 | JDG-007 | Rubric/calibration version together; agreement invalidated on change. |

### 19.8 FR-CI — CI integration

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-CI-001 | R8 | ACT-001 | Action wraps run+compare with pinned versioning. |
| FR-CI-002 | R8 | ACT-001, ACT-002 | One idempotently-updated comment with CI-bearing delta table. |
| FR-CI-003 | R8 | ACT-001 | Blocking status check fails at the configured threshold. |
| FR-CI-004 | R8 | ACT-003 | Least-privilege permissions verified and documented per feature. |
| FR-CI-005 | R8 | ACT-003 | Credentials via GitHub secrets only; never logged. |
| FR-CI-006 | R8 | ACT-005 | Baseline by branch, tag, or stored run id is explicit configuration. |
| FR-CI-007 | R8 | ACT-004 | Fork PRs run the zero-credential simulated lane only. |
| FR-CI-008 | R8 | ACT-001 through ACT-005 | Integration tests run against a real test PR in CI. |

### 19.9 FR-TRACE — trace store and viewer

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-TRACE-001 | R1 | STO-001, STO-002 | Durable atomic persistence proven at every crash marker. |
| FR-TRACE-002 | R9 | VWR-001, VWR-002 | List/get/compare queries serve reports and viewer. |
| FR-TRACE-003 | R9 | VWR-001 through VWR-005 | `assay view` serves the ADR-0011 local viewer. |
| FR-TRACE-004 | R9 | VWR-001 | Full trajectory rendered with turns, tools, metrics. |
| FR-TRACE-005 | R9 | VWR-002 | Diff locates the first divergent turn. |
| FR-TRACE-006 | R10 | STO-005, STO-006 | Explicit forward-only migrations, old fixtures, interruption recovery. |
| FR-TRACE-007 | R10 | STO-007 | Export self-contained and redacted; deletion exact. |
| FR-TRACE-008 | R9 | VWR-003 | Read-only; no mutation endpoint exists. |
| FR-TRACE-009 | R1 | STO-003 | Corruption detected and quarantined, never dropped. |
| FR-TRACE-010 | R10 | STO-007, Section 16 gc checks | Configurable retention; keep-everything-local default. |

### 19.10 FR-SAND — sandboxed execution

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-SAND-001 | R2 | SBX-001 | Dedicated OCI container per task run. |
| FR-SAND-002 | R2 | SBX-001, SBX-002 | Content-addressed materialization; harness checkout invisible. |
| FR-SAND-003 | R2 | SBX-003, SBX-004 | Network-none default; allowlists downgrade the isolation label. |
| FR-SAND-004 | R2 | SBX-006 | Container env equals the task-declared set exactly. |
| FR-SAND-005 | R2 | SBX-005 | Limit breaches are a distinct error category. |
| FR-SAND-006 | R2 | SBX-007 | Guaranteed reaping on exit, signal, and next start. |
| FR-SAND-007 | R2 | SBX-002, SBX-003, SBX-005, SBX-008 | Escape-attempt suites in CI. |
| FR-SAND-008 | R2 | AST-008, SBX-001 | Post-exit content-addressed workspace snapshot. |
| FR-SAND-009 | R2 | SBX-009 | `sandbox_unavailable` stable; never silent host exec. |
| FR-SAND-010 | R2 | SBX-010 | `--unsafe-host-exec` only, with persistent banner. |
| FR-SAND-011 | R2 | SBX-001, image-pin lint | Images pinned by digest in declarations. |
| FR-SAND-012 | R2 | SBX-002, RUN-009 | Concurrent sandboxes isolated: separate volumes, no shared writable mounts. |

### 19.11 FR-ADAPT — agent adapters

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| FR-ADAPT-001 | R1 | ADP-001 | Contract handshake, events, termination conformance. |
| FR-ADAPT-002 | R4 | ADP-001, ADP-006, ADP-008 | Conformance suite assigns tiers to every adapter. |
| FR-ADAPT-003 | R1 | ADP-004 | Simulated adapter covers all behavior classes deterministically. |
| FR-ADAPT-004 | R4 | ADP-006 | Robin adapter wraps pinned `robin --print` stream-json and conforms. |
| FR-ADAPT-005 | R1 | ADP-003 | Stderr and malformed frames bounded and classified; harness survives. |
| FR-ADAPT-006 | R4 | ADP-005 | Tool catalogs with semantic classes drive trajectory metrics. |
| FR-ADAPT-007 | R4 | ADP-008 | Black-box tier with stated measurement limits in reports. |
| FR-ADAPT-008 | R3 | PRV-001, PRV-003 | Model identity, usage, cost carried per model request. |
| FR-ADAPT-009 | R2 | SBX-006, SBX-001 | Adapter processes run inside the task's sandbox policy. |
| FR-ADAPT-010 | R1 | ADP-002 | Unknown contract majors rejected with the stable error. |

### 19.12 NFR-DET — determinism

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| NFR-DET-001 | R1 | pipeline audit + network-deny in harness | No live provider in any required check; fake-server-only transport. |
| NFR-DET-002 | R1 | RUN-010, STA-001 | All harness randomness seeded and recorded in run records. |
| NFR-DET-003 | R1 | RUN-004 | Injected clocks; golden fixtures use fixed clocks. |
| NFR-DET-004 | R1 | RUN-004, RUN-005 | Simulated e2e byte-stable across runs and platforms. |
| NFR-DET-005 | R4 | ADP-006 | Robin-synthetic e2e deterministic and free. |
| NFR-DET-006 | R3 | PRV-001, PRV-002 | Recorded fixtures cover real-provider code paths in CI. |

### 19.13 NFR-COST — cost and performance

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| NFR-COST-001 | R1 | Section 10 cost-ceiling column | Every required suite carries and honors a $0 ceiling. |
| NFR-COST-002 | R3 | PRV-008 | Nightly paid smoke <= $5, enforced by Assay's own budget gate. |
| NFR-COST-003 | R5 | BUD-005 | Published cost model drives `--dry-run` spend ceilings. |
| NFR-COST-004 | R5 | BUD-005 | Runaway guard aborts at the declared ceiling. |
| NFR-COST-005 | R2 | perf-nightly, Section 12.2 | Harness overhead p95 < 2s SLO; < 3s CI ceiling. |
| NFR-COST-006 | R9 | VWR-001 | 200-turn render p95 < 1s SLO; < 1.5s CI ceiling. |

### 19.14 NFR-SEC — security

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| NFR-SEC-001 | R10 | RED-001 through RED-006, PRV-006 | Planted corpus proves no secret in any artifact class; R4 capture, R10 bundles. |
| NFR-SEC-002 | R2 | SBX-002 through SBX-005 | Bounded isolation claims with escape tests per THREAT_MODEL. |
| NFR-SEC-003 | R7 | JDG-005, JDG-006 | Judge manipulation defenses adversarially tested. |
| NFR-SEC-004 | R3 | PRV-005, PRV-006 | Spawn-time env/keychain resolution; nothing persisted. |
| NFR-SEC-005 | R9 | VWR-004 | Loopback-only, per-session token authentication. |
| NFR-SEC-006 | R0 | dependency intake records, lockfile CI | Review gate and lockfile-only installs enforced. |
| NFR-SEC-007 | R2 | SBX-008 | Fixture archives hash-verified before materialization. |
| NFR-SEC-008 | R10 | ACT-003, Section 13.3 | Action least-privilege and provenance-published. |

### 19.15 NFR-PRIV — privacy

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| NFR-PRIV-001 | R3 | VWR-005, network-deny harness, egress docs | Local by default; only explicit provider calls egress. |
| NFR-PRIV-002 | R4 | RED-001, RED-003 | Traces redacted before persistence, fail-closed. |
| NFR-PRIV-003 | R10 | STO-007 | Export, deletion, retention per PRIVACY_AND_DATA.md mechanics. |
| NFR-PRIV-004 | R10 | RED-005 | Bundles enumerate contents and pass redaction before writing. |
| NFR-PRIV-005 | R3 | R3 gate docs check | Per-provider egress documentation complete and accurate. |
| NFR-PRIV-006 | R10 | package inventory + code audit | No telemetry exists in 1.0. |

### 19.16 NFR-MAINT — maintainability

| Requirement | Owning gate | Evidence suites | Required evidence |
| --- | --- | --- | --- |
| NFR-MAINT-001 | R0 | CFG-005 | Architecture boundary checks enforced in CI. |
| NFR-MAINT-002 | R6 | STA-008 | Mutation score >= 85% on stats and trajectory packages. |
| NFR-MAINT-003 | R10 | contract-version lint, TF-006, ADP-002 | Every public contract versioned before 1.0. |
| NFR-MAINT-004 | R0 | `lint-docs` | Current-vs-planned statements enforced by the docs check. |
| NFR-MAINT-005 | R1 | fixtures:regen review gate | Goldens regenerated only by explicit command with semantic review. |
| NFR-MAINT-006 | R0 | Section 4.2-4.3 bootstrap job | Clean clone builds with one bootstrap command. |

## 20. Release Candidate, Portfolio Readiness, and Exhaustiveness

### 20.1 Release-candidate checklist

Before a public release candidate:

- README's current status equals the highest accepted gate and includes
  the exact install and first-run path of Section 14; the verbatim
  current-baseline claim is removed only when it stops being true;
- the demo starts from the clean starter suite against the simulated
  adapter and requires no key, no container runtime, and no network;
- one recorded end-to-end shows a real PR blocked by an injected
  regression with the delta table, confidence intervals, named test, and
  q-values visible (the R8 evidence, replayed for the release record);
- one recorded end-to-end shows a budget breach failing a run with exit
  code 2 and its distinct report row;
- one recorded end-to-end shows the viewer diffing two runs and locating
  the first divergent turn;
- the compatibility record names every supported OS/arch/Node/runtime
  cell and every omission; Tier 2 and unsupported cells are explicit;
- package, license, SBOM, provenance, checksum, and signature artifacts
  verify in a clean job;
- clean-machine lifecycle (install, first run, update with migration,
  rollback with restore, uninstall, purge) is recorded on Tier 1 macOS
  and Ubuntu;
- the planted-credential scan reports zero hits across every artifact
  class;
- the flake ledger is empty for required suites, and every quarantine
  ever opened has a closed resolution;
- the statistical self-validation summary (detection power achieved,
  false-positive rate observed, interval coverage) is published with the
  release, because a gate that adjudicates other projects' regressions
  should show its own calibration;
- LANDSCAPE.md comparisons and every MARKETING.md claim pass the claim
  audit: nothing stated beyond accepted-gate evidence, and the narrow
  defensible claim is stated exactly, never inflated;
- no placeholder command, package name, URL, checksum, or support claim
  remains in published instructions.

The portfolio release must demonstrate that Assay owns its runner,
sandbox driver, adapter contract, trajectory metrics, budget evaluator,
statistics engine, judge calibration, redaction boundary, store, and
viewer. A deep operations layer is supporting evidence, not a substitute
for the user flow: suite in, verdict out, PR blocked for a defensible
reason.

### 20.2 Feature-exhaustiveness audit

Every operational surface of the product is owned by exactly one gate.
This closing audit walks the complete surface; a surface without an owner,
or with two owners, is a documentation defect that blocks the affected
gate. Ownership below matches the requirement register's terminal-owner
assignments; earlier gates may begin a surface but only the owner closes
it.

| Operational surface | Owning gate |
| --- | --- |
| GitHub CLI authentication and repository identity | R0 |
| Repository protection, required checks, branch policy | R0 |
| Toolchain, bootstrap, architecture boundaries, docs policy | R0 |
| Dependency intake and lockfile-only CI | R0 |
| Task/suite schema, inheritance, matrix, ids, `assay validate` | R1 |
| Run lifecycle, reproducibility, exit codes, rerun-append | R1 |
| Deterministic and checker assertions | R1 |
| Adapter contract, simulated adapter, malformed-frame handling | R1 |
| Store durability, corruption quarantine | R1 |
| Configuration precedence and startup validation | R1 |
| Sandbox contract, escape evidence, cleanup, unavailability error | R2 |
| Concurrency, cancellation, timeouts, crash recovery | R2 |
| Fixture materialization and hash verification | R2 |
| Provider adapters, recorded fixtures, BYOK, reconciliation | R3 |
| Paid-smoke lane and its spend ceiling | R3 |
| Per-provider egress documentation | R3 |
| Trajectory capture, metrics, scoring, capture redaction | R4 |
| Robin-synthetic e2e lane and adapter conformance tiers | R4 |
| Budget kinds, summary statistics, dry-run, runaway guard | R5 |
| Statistical engine, simulation validation, wording contract | R6 |
| Mutation-score enforcement for stats and trajectory | R6 |
| Judge rubric, calibration, agreement gate, red-team | R7 |
| GitHub Action behavior, permissions, fork lane | R8 |
| Viewer rendering, diff, security posture, accessibility | R9 |
| Packaging, provenance, signed release flow | R10 |
| Install/update/migrate/rollback/uninstall/purge lifecycle | R10 |
| Export, deletion, retention mechanics, support bundle | R10 |
| Task-format and store migrations from old fixtures | R10 |
| Contract versioning completeness and telemetry absence | R10 |
| Marketing claim audit and public result set | R10 |

### 20.3 Explicit deferrals

The following are deferred, are forbidden as completion evidence, and
reopen only through the OPEN_QUESTIONS.md triggers or a new ADR:

- native Windows support (WSL2 is the supported Windows path;
  Section 2.2);
- any hosted, multi-tenant, or team-server deployment (out of scope for
  1.0 per ADR-0002);
- cross-project or cross-repository trace aggregation;
- sequential or Bayesian statistical designs (rejected in ADR-0006; a
  reopen requires a new ADR, not a configuration flag);
- Firecracker or other VM-isolation sandbox backends (rejected in
  ADR-0004);
- telemetry of any kind (NFR-PRIV-006 forbids it in 1.0; introducing it
  later requires schema, destination, retention, and consent evidence
  before any claim);
- arm64 Linux container-image Tier 1 promotion (Tier 2 until a dedicated
  build job exists);
- macOS-hosted sandbox CI evidence beyond release-candidate manual runs
  (hosted-runner limitation; Section 2.5).

Each deferral is a statement of what Assay does not claim today. Nothing
in this section may be cited to soften a gate: if a surface above is not
deferred here, it has an owner in 20.2 and evidence in Sections 10, 18,
and 19.
