# Dependency Review Baseline

This R0 baseline records every unique external package version in `package-lock.json`.
It was generated from the exact lockfile and then reviewed on 2026-08-30 under
NFR-SEC-006. `npm audit --json --ignore-scripts` reported zero known
vulnerabilities at every severity. CI installs only with
`npm ci --ignore-scripts`; the lockfile integrity hashes select all optional
platform binaries. Sizes are review bands (tiny, small, medium, large), not
promises about a future tarball.

## R1 SQLite intake

`packages/run-store` uses `better-sqlite3@13.0.3` behind the `RunStore`
interface for the WAL-mode, transactional, crash-injected local store required
by ADR-0008. The pinned Node 22 line's `node:sqlite` surface was not the stable
baseline selected by ADR-0001, while an ORM would add an unnecessary schema
and migration layer expressly excluded by the operations policy.

The exact registry tarball is MIT licensed, maintained by the WiseLibs
project, and belongs to the package's active major line. It adds one runtime
dependency, `node-addon-api@8.9.2`, plus the development-only
`@types/better-sqlite3@9.6.0`. The installed direct package is approximately
26 MiB and includes platform prebuilds and C++ source; version 13.0.3 declares
no install lifecycle script, so the required `npm ci --ignore-scripts` path
uses only integrity-pinned tarball contents. The package receives only an
injected local database path and record bytes: it has no credential,
environment, provider, or network capability. Temporary-store, lock,
corruption, and crash-injection tests are its deterministic seam.

`npm audit --package-lock-only` reported zero known vulnerabilities on
2026-08-30. Updates require a fresh native/prebuild, ABI, lockfile, crash, and
migration review; rollback is the exact manifest and lockfile reversal while
stored schema v1 remains unchanged. Removal would replace only the private
`RunStore` implementation, but must retain WAL, transaction, integrity, and
quarantine evidence.

| Package | Relationship | License | Release cadence | Declared transitive dependencies | Native/binary | Install size | Security notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@esbuild/aix-ppc64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/android-arm@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/android-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/android-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/darwin-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/darwin-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/freebsd-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/freebsd-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-arm@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-ia32@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-loong64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-mips64el@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-ppc64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-riscv64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-s390x@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/linux-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/netbsd-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/netbsd-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/openbsd-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/openbsd-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/openharmony-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/sunos-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/win32-arm64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/win32-ia32@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@esbuild/win32-x64@0.28.2` | optional platform | MIT | active; frequent esbuild releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@jridgewell/sourcemap-codec@1.6.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@napi-rs/lzma-linux-x64-gnu@1.5.1` | optional platform | MIT | maintenance; stable transitive utility | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-android-arm-eabi@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-android-arm64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-darwin-arm64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-darwin-x64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-freebsd-arm64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-freebsd-x64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-arm-gnueabihf@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-arm-musleabihf@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-arm64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-arm64-musl@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-loong64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-loong64-musl@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-ppc64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-ppc64-musl@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-riscv64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-riscv64-musl@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-s390x-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-x64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-linux-x64-musl@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-openbsd-x64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-openharmony-arm64@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-win32-arm64-msvc@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-win32-ia32-msvc@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-win32-x64-gnu@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@rollup/rollup-win32-x64-msvc@4.63.1` | optional platform | MIT | active; frequent Rollup releases | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `@types/better-sqlite3@9.6.0` | direct | MIT | active; follows DefinitelyTyped package updates | 1: @types/node | JavaScript | tiny | Development declarations only; exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@types/chai@5.2.3` | transitive | MIT | active; scheduled ecosystem releases | 2: @types/deep-eql, assertion-error | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@types/deep-eql@4.0.2` | transitive | MIT | active; scheduled ecosystem releases | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@types/estree@1.0.9` | transitive | MIT | active; scheduled ecosystem releases | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@types/node@22.20.1` | direct | MIT | active; scheduled ecosystem releases | 1: undici-types | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/expect@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 5: @types/chai, @vitest/spy, @vitest/utils, chai, tinyrainbow | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/mocker@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 3: @vitest/spy, estree-walker, magic-string | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/pretty-format@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 1: tinyrainbow | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/runner@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 3: @vitest/utils, pathe, strip-literal | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/snapshot@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 3: @vitest/pretty-format, magic-string, pathe | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/spy@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 1: tinyspy | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `@vitest/utils@3.2.7` | transitive | MIT | active; frequent Vite or Vitest releases | 3: @vitest/pretty-format, loupe, tinyrainbow | JavaScript | medium | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `ajv@8.20.0` | direct | MIT | active; periodic schema-validator releases | 4: fast-deep-equal, fast-uri, json-schema-traverse, require-from-string | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `assertion-error@2.0.1` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `better-sqlite3@13.0.3` | direct | MIT | active; maintained WiseLibs major line | 1: node-addon-api | native binary | large | Run-store boundary only; bundled platform prebuilds and source are integrity pinned; no install lifecycle script; npm audit 2026-08-30: 0 advisories. |
| `cac@6.7.14` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `chai@5.3.3` | transitive | MIT | maintenance; stable transitive utility | 5: assertion-error, check-error, deep-eql, loupe, pathval | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `check-error@2.1.3` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `debug@4.4.3` | transitive | MIT | maintenance; stable transitive utility | 1: ms | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `deep-eql@5.0.2` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `es-module-lexer@1.7.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `esbuild@0.28.2` | direct | MIT | active; frequent esbuild releases | 26: @esbuild/aix-ppc64, @esbuild/android-arm, @esbuild/android-arm64, @esbuild/android-x64, @esbuild/darwin-arm64, @esbuild/darwin-x64, @esbuild/freebsd-arm64, @esbuild/freebsd-x64, @esbuild/linux-arm, @esbuild/linux-arm64, @esbuild/linux-ia32, @esbuild/linux-loong64, @esbuild/linux-mips64el, @esbuild/linux-ppc64, @esbuild/linux-riscv64, @esbuild/linux-s390x, @esbuild/linux-x64, @esbuild/netbsd-arm64, @esbuild/netbsd-x64, @esbuild/openbsd-arm64, @esbuild/openbsd-x64, @esbuild/openharmony-arm64, @esbuild/sunos-x64, @esbuild/win32-arm64, @esbuild/win32-ia32, @esbuild/win32-x64 | JavaScript | large | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `estree-walker@3.0.3` | transitive | MIT | maintenance; stable transitive utility | 1: @types/estree | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `expect-type@1.4.0` | transitive | Apache-2.0 | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `fast-check@4.9.0` | direct | MIT | active; periodic property-test releases | 1: pure-rand | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `fast-deep-equal@3.1.3` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `fast-uri@3.1.6` | transitive | BSD-3-Clause | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `fdir@6.5.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `fsevents@2.3.3` | optional platform | MIT | maintenance; stable transitive utility | none | native binary | large | Platform-selected binary; lockfile integrity pinned; npm audit 2026-08-30: 0 advisories. |
| `js-tokens@9.0.1` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `json-schema-traverse@1.0.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `loupe@3.2.1` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `magic-string@0.30.21` | transitive | MIT | maintenance; stable transitive utility | 1: @jridgewell/sourcemap-codec | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `ms@2.1.3` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `nanoid@3.3.18` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `node-addon-api@8.9.2` | transitive | MIT | active; maintained Node-API headers | none | none | small | Header dependency of better-sqlite3; exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `pathe@2.0.3` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `pathval@2.0.1` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `picocolors@1.1.1` | transitive | ISC | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `picomatch@4.0.7` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `postcss@8.5.26` | transitive | MIT | maintenance; stable transitive utility | 3: nanoid, picocolors, source-map-js | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `pure-rand@8.4.2` | transitive | MIT | active; periodic property-test releases | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `require-from-string@2.0.2` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `rollup@4.63.1` | transitive | MIT | active; frequent Rollup releases | 28: @napi-rs/lzma-linux-x64-gnu, @rollup/rollup-android-arm-eabi, @rollup/rollup-android-arm64, @rollup/rollup-darwin-arm64, @rollup/rollup-darwin-x64, @rollup/rollup-freebsd-arm64, @rollup/rollup-freebsd-x64, @rollup/rollup-linux-arm-gnueabihf, @rollup/rollup-linux-arm-musleabihf, @rollup/rollup-linux-arm64-gnu, @rollup/rollup-linux-arm64-musl, @rollup/rollup-linux-loong64-gnu, @rollup/rollup-linux-loong64-musl, @rollup/rollup-linux-ppc64-gnu, @rollup/rollup-linux-ppc64-musl, @rollup/rollup-linux-riscv64-gnu, @rollup/rollup-linux-riscv64-musl, @rollup/rollup-linux-s390x-gnu, @rollup/rollup-linux-x64-gnu, @rollup/rollup-linux-x64-musl, @rollup/rollup-openbsd-x64, @rollup/rollup-openharmony-arm64, @rollup/rollup-win32-arm64-msvc, @rollup/rollup-win32-ia32-msvc, @rollup/rollup-win32-x64-gnu, @rollup/rollup-win32-x64-msvc, @types/estree, fsevents | JavaScript | large | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `siginfo@2.0.0` | transitive | ISC | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `source-map-js@1.2.1` | transitive | BSD-3-Clause | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `stackback@0.0.2` | transitive | MIT | low cadence; stable tiny utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `std-env@3.10.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `strip-literal@3.1.0` | transitive | MIT | maintenance; stable transitive utility | 1: js-tokens | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinybench@2.9.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinyexec@0.3.2` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinyglobby@0.2.17` | transitive | MIT | maintenance; stable transitive utility | 2: fdir, picomatch | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinypool@1.1.1` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinyrainbow@2.0.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tinyspy@4.0.4` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `tsx@4.23.13` | direct | MIT | active; periodic maintained releases | 2: esbuild, fsevents | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `typescript@5.9.3` | direct | Apache-2.0 | active; scheduled ecosystem releases | none | JavaScript | large | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `undici-types@6.21.0` | transitive | MIT | maintenance; stable transitive utility | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `vite-node@3.2.4` | transitive | MIT | active; frequent Vite or Vitest releases | 5: cac, debug, es-module-lexer, pathe, vite | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `vite@7.3.6` | transitive | MIT | active; frequent Vite or Vitest releases | 7: esbuild, fdir, fsevents, picomatch, postcss, rollup, tinyglobby | JavaScript | large | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `vitest@3.2.7` | direct | MIT | active; frequent Vite or Vitest releases | 23: @types/chai, @vitest/expect, @vitest/mocker, @vitest/pretty-format, @vitest/runner, @vitest/snapshot, @vitest/spy, @vitest/utils, chai, debug, expect-type, magic-string, pathe, picomatch, std-env, tinybench, tinyexec, tinyglobby, tinypool, tinyrainbow, vite, vite-node, why-is-node-running | JavaScript | large | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `why-is-node-running@2.3.0` | transitive | MIT | maintenance; stable transitive utility | 2: siginfo, stackback | JavaScript | small | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
| `yaml@2.9.0` | direct | ISC | active; periodic maintained releases | none | JavaScript | tiny | Exact lockfile pin; npm audit 2026-08-30: 0 advisories. |
