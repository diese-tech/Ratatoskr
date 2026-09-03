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
