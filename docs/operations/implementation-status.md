# Implementation checkpoint

Authorized scope: B1 in `docs/plans/backlog-execution-plan.md` v1.3.
Commit each meaningful chunk with Done, Validation and Next in the commit body.
Apply this process to every authorized batch, preserving separate code/deployment/live evidence.

## Current checkpoint — B1 code complete

Read this section first. Entries below it preserve the chronological handoff history
and may describe next steps that have since been completed.

Done: all seven B1 slices are implemented in stacked PRs #70–#76. Automated review
findings were repaired: shared franchise-role creation across divisions, nested
interaction error context, duplicate visible player names, and stale plan progress.
The final boundary also acknowledges errors before staff lookup. Review details
are in `b1-review-status.md`; scope and PR links are in plan v1.4.

Validation: 168 tests, application/script typechecks, build and zero-vulnerability
dependency audit pass on Node 24.14.1. New first-publication integration verifies
separate signup and roster messages in signups with safe stale retries. A disk
upgrade from synthetic v14 data preserves active, pending and historical setups,
slots, signups and legacy channel/message IDs; SQLite integrity/foreign-key checks
pass. This is not a rehearsal against a production backup.

Remote evidence before the final checkpoint: PR70 5f81d4b, PR71 fc2192d,
PR72 ebbf9de, PR73 28bb74f, PR74 d732feb, PR75 26a18dc and PR76 ed9ebf2
all passed both Ubuntu and Windows CI. The final commit adds the migration
regression and this documentation; verify its PR76 checks before merging.

Next: verify CI on the final pushed commit; follow `b1-rollout-checklist.md` for
the concrete merge/deployment gate and focused live acceptance. Main remains
866407f. No B1 PR has merged, no production changes were made, and #69/#45/#62/#36
remain open pending their acceptance evidence. Do not begin B2 without further
authorization. Keep Done/Validation/Next commits for every future authorized batch.

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

## B1.5 checkpoint (codex/b1-staff-errors)

Done: Managed staff-ops operational reports, private/log correlation, redaction, permission validation and bounded duplicate suppression; connected to command, reaction and Scout recovery failures.

Validation: 152 tests and application typecheck pass; delivery, missing/public/wrong-guild channels, denied permissions, redaction and repeated alerts covered.

Next: B1.6: direct cancellable-posting picker with authorization filtering, paging and stale confirmation tests. Staff-ops live smoke remains pending.

Deployment/live verification: pending; no production changes.

## B1.6 checkpoint (codex/b1-cancel-picker)

Done: Direct private active-posting list across authorized divisions, pagination, confirmation, legacy-control compatibility and early interaction acknowledgement.

Validation: 156 tests and application typecheck pass; zero/one/many postings, access changes, stale versions, published exclusion and real cancellation repair verified.

Next: B1.7 / #69: readable player names in all draft/published swap and replacement selectors; verify exact Game 2 selection and name fallback.

Deployment/live verification: pending; no production changes.

## B1.7 checkpoint A — readable names

Done: shared per-view player-name resolution for draft/published swap/replacement
menus and eligible replacement candidates; compact labels retain game/team/role
and stable internal slot IDs. Draft interactions defer before member lookups.

Validation: 158 tests and app typecheck pass, including cached/fetched guild names,
global/user fallback, unresolved users, duplicate names and bounded labels.

Next: finish real one/two-game draft and published selector-to-mutation tests,
verify Game 2 notices, then open the #69 implementation PR and run final B1 gates.
Live mobile acceptance remains pending. No production changes.

## B1.7 checkpoint (codex/b1-player-names)

Done: Readable names across draft and published swaps/replacements, including eligible candidates; preserved exact slot values and one/two-game behavior.

Validation: 162 tests and application typecheck pass; real selector-to-mutation paths verify exact Game 2 replacement, swaps and published notices.

Next: Run final B1 build/script typecheck/audit and inspect the complete diff; open #69 PR, verify all stacked CI, record review/deployment/live gates. Do not start B2.

Deployment/live verification: pending; no production changes.
