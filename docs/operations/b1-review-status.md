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

## Player identity and publication acceptance (PR #76)

Done: colliding visible player names include a username, or a unique abbreviated
account ID when a username is unavailable. The original stable selection values
are preserved. A real first-publication check verifies two distinct messages in
signups, the original signup link, and no duplicate roster on stale confirmation.

Validation: duplicate-name regressions failed before repair; 14 player-name and
publication integration tests plus application typecheck pass. The preceding
complete B1 run passed 166 tests, both typechecks, build and dependency audit.

Next: rehearse migration 15 on synthetic v14 lifecycle data, finish final gates
and update the plan/CI snapshot. Production backup rehearsal and live acceptance
remain pending; no channels or production data have been changed.

## Final migration and continuity checkpoint

Done: a disk-backed v14 fixture covers posting, open, roster-ready, pending and
settled published, and cancelled setups. Startup migration 15 preserves the
existing lifecycle rows and original channel/message IDs. Plan v1.4 records every
implemented slice and its PR, fixing the stale B1.1 progress finding on PR #70.
`b1-rollout-checklist.md` records the remaining concrete operational gates.

Validation: all 168 tests, application/script typechecks, build and dependency
audit pass. SQLite integrity and foreign-key checks pass after the upgrade.
All seven functional PR heads passed Windows and Ubuntu CI before this checkpoint.

Next: verify the final checkpoint's CI and hand off the stack for the documented
merge/deployment gate. No production backup or live Discord acceptance is claimed.
