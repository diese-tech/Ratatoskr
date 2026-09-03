# Implementation checkpoint

Authorized scope: B1, the B2 Lucid telemetry adaptation and the user's recovered
stale-post management follow-up; see `docs/plans/backlog-execution-plan.md` v1.8,
`b2-scout-telemetry.md` and `scout-stale-post-management.md`.
Commit each meaningful chunk with Done, Validation and Next in the commit body.
Apply this process to every authorized batch, preserving separate code/deployment/live evidence.

## Current checkpoint — recovered-post management merged and startup verified

Done: checkpoint 8777d03 adds direct cancellation to recovered cards and repairs
cancellation display/cleanup. Checkpoint 3ba4306 adds durable published completion,
Swap/Replace in Scout Ops, stale-form/database write fences, and restart cleanup.
The user's screenshot verifies B2 recovery/display, not full interaction acceptance.

Merged: PR #79 at cd1be71284fafc7c69d0058807d046889101238d, preserving both commits.
Validation: 196 local tests, both typechecks, build and dependency audit pass. Fixtures
exercise missing/forbidden messages, private confirmation authorization, pending
delivery fences, disk restart/upgrades and legacy two-game routing. See the
follow-up plan for the contract and rollback implications of completion records.
PR CI 33758762949 and main CI 33758944912 passed on Windows and Ubuntu. Railway
deployment ba9e274e-fe5c-49ea-bd29-c632709f1463 succeeded; database/login/registration,
finished-post recovery and control-card recovery completed without startup errors
at 13:07:07 UTC on September 3. The persistent volume was mounted.

Next: complete the full B1/B2 live Discord acceptance session tracked by
[#45](https://github.com/diese-tech/Ratatoskr/issues/45) and
[#62](https://github.com/diese-tech/Ratatoskr/issues/62), as planned in B3 of the
[backlog execution plan](../plans/backlog-execution-plan.md). Use the current
[Scout workflow](scout-workflow.md): signup-channel roster routing and historical
controls, staff/captain authorization, eligibility and Fill, intentional same-time
setups and division isolation, one/two-game review, shuffle and publication, swaps and
replacements with readable mobile selectors, staff-ops reporting, readiness
telemetry/creator notification, and restart recovery. Retain separate evidence
for both acceptance issues. The user-selected stale-post cancel/finish checks
supplement this full session; they do not replace it.

The production-copy restore rehearsal and clarification of date/time
rescheduling also remain outstanding. These live checks and decisions remain
separate from the completed CI, merge and startup checks.

For future merges, require green CI and completed automated review with all
findings addressed on the final PR head. After any fix changes that head, wait
for both CI and a new automated review to complete again; merge only the unchanged
reviewed commit. Keep Railway auto-deploy ON and inspect the new deployment's
logs. No production setups are being automatically closed and no date/time
editing or reminder scheduler is included.

The previous checkpoints below are historical snapshots. Their Next entries
record what was pending at that time; use the current checkpoint above to resume.
Their historical label does not retire outstanding issue acceptance checklists.

## Previous checkpoint — B1/B2 merged and deployment startup verified

Done: B1 PRs #70-#76 merged in order, ending at c594500; B2 #77 merged separately
at 4ca02d0. The user directed automatic Railway deployments to remain enabled,
with logs checked between merges. Auto-deploy is ON. Each post-hold rollout
reported success, database ready, bot online, commands registered and all Scout
reconciliation completed. Node 24.19.0 was selected by the production build.

Validation: fresh Windows/Ubuntu checks passed before each merge; complete B1
and B2 main CI passed (runs 33731791579 and 33731963595). All 187 cumulative tests
pass. Exact commits, deployment IDs and timestamps are in `batch-integration.md`.

Next: complete focused live Discord acceptance and the production-copy restore
rehearsal; keep these distinct from deployment/startup verification. #68/#69 and
the full #45/#62 acceptance issues remain open. The one-hour reminder remains a
separate follow-up; B3-B7 are not implemented by this integration.

## Previous checkpoint — B2 code complete, before integration

Done: reviewed Lucid main 827b7b8, its existing persistent card, and open issue #30;
implemented the preferred Ratatoskr lifecycle in a separate branch above B1.
Counts appear immediately after signup posting, persist in the fresh ready panel
through private review, and remain as a labelled historical snapshot after closure.
The shared matcher and eligibility service govern all counts. Migration 16 adds
durable card/snapshot/attempt state. No reminder scheduler was added.
Review fixes: 13dc695 retries confirmed message-creation rejections without
repeating an earlier creator ping; b54f0f0 freezes current counts atomically with
publication/cancellation, independently of delayed card delivery. Both reported
failures were reproduced before repair.

Validation: 187 tests, application/script typechecks, build and dependency audit
pass. Fifteen real lifecycle/recovery scenarios cover reactions, eligibility changes,
two-game review/publication, cancelled/open/concurrent setups, disk restart,
ambiguous sends and denied cleanup. A delayed-card regression now proves that
new signup writes remain responsive. v14/v15 disk upgrades preserve existing
rows and B1 pending roster notices.

Next: verify the final PR #77 head has green CI; integrate B1 and B2 separately
using the documented production-change gates. Rehearse migration 16 on a
consistent production backup and run the focused Discord card/notification tests.
No branch is merged or deployed. Reminders are a separate follow-up; B3 full
acceptance and B4–B7 remain outside this implementation. Preserve meaningful
Done/Validation/Next commits on all later authorized work.

## Previous checkpoint — B1 code complete

Entries below preserve the chronological B1 handoff history
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
