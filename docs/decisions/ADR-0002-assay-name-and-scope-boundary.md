# ADR-0002: Product Name Assay and Positioning Boundary

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: NFR-PRIV-001, NFR-PRIV-006,
  FR-TRACE-003, FR-CI-003

## Context

Before any planning document can make a scope claim, the product needs a
fixed name and an explicit boundary around what it is not. The evaluation
market is crowded — promptfoo, Braintrust, LangSmith, OpenAI Evals, and
inspect-ai all exist — and several of them bundle observability dashboards,
prompt playgrounds, and hosted backends. Without a recorded boundary, every
future feature discussion drifts toward becoming a platform, and every
document risks overstating novelty. The name and the boundary are decided
together because the name carries the positioning: an assay is a controlled
quantitative test, not a monitoring service.

## Decision

The product name Assay is retained; the executable is `assay`. Assay is a
CI regression gate for agent behavior: it blocks a pull request on a
statistically defended trajectory-quality or cost regression of a coding
agent, runnable entirely locally against a deterministic synthetic agent
for zero dollars. Assay is NOT an observability platform, NOT a prompt
playground, NOT a dataset labeling tool, and NOT a hosted service. Anything
requiring a hosted multi-tenant backend is out of scope for 1.0.

## Alternatives Considered

- Broaden scope to an observability platform: rejected because live-traffic
  monitoring requires a hosted ingestion backend, contradicts the
  local-first data posture (NFR-PRIV-001), and puts Assay in direct feature
  competition with funded incumbents on ground where it has no edge.
- Include a prompt playground: rejected because interactive prompt
  iteration optimizes for exploration, while a gate optimizes for
  reproducibility; the two pull the storage model, UI, and statistics in
  opposite directions, and playgrounds are already well served.
- Offer a hosted service at 1.0: rejected because multi-tenancy would
  demand authentication, tenant isolation, and telemetry that the privacy
  posture forbids (NFR-PRIV-006), and would move the trust boundary from
  the user's machine to an operated service before any gate has evidence.
- Rename to avoid collision risk: rejected because no conflicting product
  claim was identified in the evaluated space and the term's meaning — a
  controlled quantitative test of composition — is exactly the positioning.

## Consequences

Every document can state scope in one sentence, and feature requests that
require a hosted backend are answered by citation rather than debate. The
local viewer (ADR-0011) and local trace store (ADR-0008) follow directly
from this boundary.

The cost is a real ceiling: teams wanting fleet-wide dashboards must export
bundles rather than point at a service. This boundary is revisited only if
1.0 ships and sustained demand for shared result storage cannot be met by
exported bundles in CI artifacts; that reversal would be a new ADR, not an
edit to this one.
