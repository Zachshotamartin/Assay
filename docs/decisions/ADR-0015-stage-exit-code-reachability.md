# ADR-0015: Stage Exit-Code Reachability by Owning Subsystem

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-RUN-010, FR-BUD-002, FR-STAT-007,
  FR-CI-003, RUN-007, BUD-001, BUD-003, R1, R5, R6, R8

## Context

Product Requirements section 5.1 fixes a seven-outcome process contract:
success (0), task failure (1), budget breach (2), comparison regression (3),
invalid input or configuration (4), infrastructure error (5), and
cancellation (6). FR-RUN-010 assigns the stability of that contract to R1.

The detailed R1 evidence matrix, however, requires subprocess scenarios for
0, 1, 4, 5, and 6 while R1's explicit deferrals assign budget evaluation to
R5 and statistical comparison to R6. The Operations test register instead
describes RUN-007 as proving all seven outcomes before R1 can be accepted.
That creates an impossible gate cycle: R2 requires accepted R1, R5 and R6
require the intervening accepted gates, and R1 would require behavior that
those later gates exclusively own. A fake budget or comparison switch would
be a stub and therefore cannot count as completion.

## Decision

FR-RUN-010 remains terminally owned by R1 for the complete public contract:
the seven numeric values, their meanings, their precedence, their stable
category mapping, and the shared typed representation are frozen and tested
at R1. Runtime reachability is cumulative and is proved only when the
subsystem capable of producing an outcome exists:

- R1 subprocess evidence must produce 0, 1, 4, 5, and 6 through real
  validation and run scenarios. It also tests the complete seven-value type
  and category-to-exit mapping without inventing a deferred subsystem.
- R5 first makes exit code 2 reachable through the real budget evaluator;
  BUD-001 and BUD-003 are its terminal subprocess and report evidence.
- R6 first makes exit code 3 reachable through the real comparison pipeline;
  its comparison command and wording-contract evidence prove that the code
  fires for `regression detected` and for no other verdict.
- R8 exercises all seven codes together as forwarding and status-mapping
  evidence. The Action passes harness exit codes through; it does not own or
  reinterpret their semantics.

RUN-007 and the R1 acceptance text therefore cover the five R1-reachable
outcomes. The R5 and R6 evidence completes runtime reachability for the two
deferred outcomes. The public seven-code contract, including every numeric
value and precedence rule, is unchanged.

## Alternatives Considered

- Require R1 to implement budgets and comparisons: rejected because it
  violates the fixed gate order and duplicates the R5 and R6 owners.
- Add hidden CLI flags that force exits 2 and 3: rejected because test-only
  stubs would not prove the user-visible behavior and are explicitly
  forbidden as completion evidence.
- Delay all exit-code ownership to R6: rejected because scripts and every
  later subsystem need the stable numeric contract from R1.
- Renumber or collapse outcomes until later gates: rejected because Product
  Requirements section 5.1 already fixes the public contract verbatim.

## Consequences

R1 can be accepted after proving every behavior it implements while still
freezing all seven stable codes. R5 and R6 inherit the earlier subprocess
suite and add genuine reachability evidence for their respective outcomes.
The final all-seven integration proof occurs no later than R8. Evidence and
status claims must distinguish a frozen mapping from a reachable outcome;
neither a type nor a placeholder may be cited as proof of a deferred
subsystem.
