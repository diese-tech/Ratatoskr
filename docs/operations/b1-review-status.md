# B1 review follow-up

## Shared franchise role (PR #71)

Done: concurrent provisioning for different divisions now joins one guild-wide
franchise-role repair. Division-specific work retains its independent guard.
This fixes review discussion r3920495509 without serializing all divisions.

Validation: the real concurrent provisioning regression first reproduced two
Discord role creations; after repair it creates/tracks one and both callers
continue to their own division resources. The targeted suite and typecheck pass.

Next: propagate this fix through the dependent B1 branches; correct component
error context and acknowledgement timing in PR #74, then finish cumulative gates.
No production changes; full bootstrap remains a separate maintenance operation.

## Interaction error boundary (PR #74)

Done: decode nested draft/published/cancellation component layouts into the actual
operation and setup ID, including legacy cancellation values. Division IDs, page
numbers and creation draft IDs are not treated as setup IDs. This fixes review
discussion r3920629100. A fresh error reply is deferred privately before staff
lookup; expired tokens still produce the operational report.

Validation: both context and timing regressions failed against the former boundary;
all 10 operational-report tests and application typecheck now pass. Separate setup
failures produce independent staff reports even when the second token expired.

Next: propagate through PR #75/#76, run complete B1 gates, record current CI and
the deployment/migration/live acceptance checklist. Do not start B2.
