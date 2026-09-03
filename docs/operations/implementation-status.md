# Implementation checkpoint

Authorized scope: B1 in `docs/plans/backlog-execution-plan.md` v1.3.
Commit each meaningful chunk with Done, Validation and Next in the commit body.
Apply this process to every authorized batch, preserving separate code/deployment/live evidence.

## B1.1 — validation/runtime

Done: quote the test glob so Node handles recursive discovery on both shells;
pin Node 24; run the CI matrix on Ubuntu and Windows; document runtime/volume checks.

Validation: Node 24.14.1, locked native SQLite installation, all 133 baseline tests,
application/script typechecks, build and dependency audit pass locally.
Remote CI and Railway runtime verification remain pending. No production changes.

Next: open the B1.1 PR and verify both CI jobs. Continue B1.2 with regressions for
managed franchise-role identity, interrupted channel-parent repair and pending-work
teardown/concurrency guards. Then B1.3 routing, B1.4 durable writes, B1.5 reporting,
B1.6 cancellation and B1.7 readable names. B2 remains out of current scope.

## B1.2 checkpoint (codex/b1-division-safety)

Done: Managed franchise-role identity, interrupted parent repair, pending-publication teardown blockers and per-division create/teardown exclusion.

Validation: 136 tests and application typecheck pass; posting blocker regression reproduced before fix.

Next: B1.3: route new roster posts into signup channels while preserving historical/pending destinations. PR70 is the base; verify stacked CI.

Deployment/live verification: pending; no production changes.

## B1.3 checkpoint (codex/b1-signup-publication)

Done: Publish new/unclaimed rosters in signup channels; retain legacy pending/published destinations; allow player screenshots in results. No bulk rewrite or schema migration.

Validation: 137 tests and application typecheck pass; routing claim, stale versions and player permission checks covered.

Next: B1.4: reproduce published Swap double acknowledgement, then add durable roster edit/notice recovery and failure-injection tests.

Deployment/live verification: pending; no production changes.

## B1.4 checkpoint A — durable published updates

Done: migration 15 adds one pending roster update per setup; roster mutation and
notice intent commit atomically. Published selectors acknowledge once before API
lookups. Recovery edits the original message and retains uncertain notice delivery
instead of rolling back or blindly sending twice. Live edits share the division guard.

Validation: 139 tests and application typecheck pass; both original failures now
pass as real handler regressions. PR70/71/72 CI passes on both Windows and Linux.

Next: add disk-restart, lost-notice-response, unavailable-message and stale/unauthorized
failure coverage; finish operator recovery instructions; then open the B1.4 PR.
B1.4 is in progress. Production and live Discord verification remain untouched.

## B1.4 checkpoint (codex/b1-published-recovery)

Done: Exactly-once interaction acknowledgement; transactional pending roster edits/notices; restart repair, version guards and exact marker matching. Migration 15 is append-only.

Validation: 144 tests and application typecheck pass; disk restart, lost edit/send responses, uncertain notice, stale/unauthorized/missing-message cases covered.

Next: B1.5: safe staff-ops error reporting with matching private/process references. Verify B1.4 stacked CI and rehearse migration before deployment.

Deployment/live verification: pending; no production changes.
