# R1 Documentation Fixture

## Implementation Status

> Assay is under implementation. Gate R0 is accepted with repository, toolchain, CI, and GitHub governance evidence. Gate R1 has code and local evidence in progress; gates R2 through R10 remain planned. No evaluation product gate is accepted.

| Gate | Status |
| --- | --- |
| R0 | accepted |
| R1 | in progress |
| R2 | planned |
| R3 | planned |
| R4 | planned |
| R5 | planned |
| R6 | planned |
| R7 | planned |
| R8 | planned |
| R9 | planned |
| R10 | planned |

## Source-checkout R1 Preview (Unaccepted)

The R1 gate branch can build and exercise the deterministic reference corpus
from source with Node.js 22. This is source-only preview evidence, not a
published install or an acceptance claim:

```sh
npm ci --ignore-scripts
npm run build
node apps/cli/dist/bin.js validate fixtures/suites/reference
node apps/cli/dist/bin.js run fixtures/suites/reference.suite.yaml --variant baseline --adapter simulated -n 10 --seed 42
```

R1 has no sandbox or isolation boundary. Every R1 execution is durable
`unsafe_host` evidence and prints the unsafe-host warning. The only supported
R1 subject is the deterministic in-repo simulated adapter.
No real agent or provider is supported, and this workflow makes no provider call.
