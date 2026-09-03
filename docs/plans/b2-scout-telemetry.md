# B2 — persistent Scout readiness cards

Authorized direction: review Lucid and adapt its persistent visual staff display
to Ratatoskr using the lifecycle preferred in this conversation. This is a
separate B2 branch/PR above B1; no merge or production deployment is authorized.
Reminder scheduling remains a separate follow-up feature.

## Source review

Lucid main 827b7b8371443463b9bd3579746f73b406277848 already creates a staff
card alongside the signup post and updates it on reactions and roster changes.
Its `src/discord/render.ts` separates presentation from flow orchestration;
`src/discord/flows/review.ts` owns card refresh. Its existing open card counts raw
signup rows. Detailed unique/eligible role telemetry is still planned in Lucid
#30, not implemented. Ratatoskr #68 also remains open.

Adopt the persistent staff visibility and diagnostic presentation. Preserve
Ratatoskr's setup/division snapshots, private roster review, two-channel contract,
canonical eligibility/matching, and fresh ready-panel creator notification.
Do not adopt Lucid's guild-wide routing, premade format or proposed rejection of
ineligible reactions; Ratatoskr retains reactions and filters eligibility.

## Lifecycle and display

1. After the public signup post succeeds, create one status-only card in the
   setup's snapshotted scout-ops channel. Private creation previews create no card.
2. Show unique eligible players against 10 (20 for a two-game draft), uncapped
   standard-role counts against 2/4, Fill separately, and actual matching blockers.
   Role counts overlap; Fill coverage must not produce false missing-role warnings.
3. Once canonical readiness creates a draft, delete the temporary card with
   confirmed cleanup, then send the fresh normal ready panel and notify its
   creator. Carry telemetry into this new panel and continue live updates through
   review. Existing ready panels gain telemetry in place without another ping.
4. Reactions, membership/eligibility changes and draft mutations refresh the view.
   Show eligible unseated participants as overflow after a draft exists, without
   treating role overage as unique spare players. No new overflow picker in B2.
5. Publication/cancellation leaves a terminal card with its last recorded signup
   snapshot and time, plus the published roster link when available. Counts are
   explicitly historical after closure, not confirmed substitute availability.

## Reliability and acceptance

Append migration 16 for telemetry identity, attempted sends and the last snapshot.
Serialize per-setup card writes; use exact durable markers and paginated recovery.
Retain state on ambiguous sends/deletes and 403s; only confirmed absence permits
replacement. Telemetry errors report to staff-ops without undoing signup/roster
work. Recover open, ready and terminal cards on startup without duplicate pings.

Test zero signups, overlapping reactions, overflow, Fill, one/two-game targets,
missing roles, flex overlap, eligibility loss/gain/departure, live reaction and
draft refreshes, fresh ready notification, terminal snapshots, restart/ambiguous
delivery, denied cleanup and simultaneous setups. Run the full inherited gates.

Next: implement the shared snapshot/rendering layer and durable card lifecycle,
wire existing events, test recovery, update #68's adoption contract in repository
documentation, and open a separate reviewable B2 PR. Keep Done/Validation/Next
commit bodies after each meaningful chunk. B1 deployment/live gates remain open.

## Checkpoint 1 — snapshot and persistence foundation

Done: pure readiness snapshot/rendering reuses canonical matching, counts distinct
players and uncapped roles, handles Fill coverage/flex overlap, two-game targets,
current-draft warnings and historical display. Migration 16 adds card identity,
send-attempt state and the last saved snapshot without modifying existing rows.

Validation: three domain tests and application typecheck pass. Next: durable
Discord card lifecycle, event wiring and recovery/upgrade integration tests.

## Checkpoint 2 — card lifecycle and live events

Done: one serialized card writer handles temporary telemetry, confirmed cleanup,
fresh ready notification, live review updates and terminal snapshots. Creation,
reactions, draft mutations, membership/role changes and startup call the writer.
Canonical eligibility now excludes departed/bot members and fails visibly when
role/member access cannot be verified. Attempt state distinguishes a lost response
from a confirmed missing message, including replacement ready panels.

Validation: application typecheck and six focused domain/control-panel tests pass.
Next: real creation/reaction/member/draft flow fixtures, duplicate/ambiguous send
and deletion tests, disk restart/upgrade checks, then cumulative gates and review.
Implementation is in progress; no production changes.

## Checkpoint 3 — interaction and recovery verification

Done: nine integration scenarios exercise real creation, signup add/remove,
eligibility gain/loss/departure, two-game build and publication, cancellation,
concurrent setups, disk restart, lost initial/replacement responses, denied
cleanup/access and paginated exact-marker recovery. Terminal cards retain a
frozen snapshot. Missing eligibility roles visibly mark live data unavailable.

Validation: 180 tests pass before the final upgrade addition. Next: finish v14/v15
upgrade preservation checks (including B1's pending roster outbox), run typechecks,
build/audit, update plan/operator docs, and verify the B2 PR on both CI platforms.

## Checkpoint 4 — keep signup processing responsive

Done: move live staff-card refresh outside the signup/membership persistence lock
and skip unchanged Discord card edits. Card writes still serialize separately and
re-read canonical state. A delayed edit can no longer delay another signup write.

Validation: the real delayed-edit regression failed before repair (one signup
persisted instead of two); all ten lifecycle integration tests and typecheck pass.
Next: final cumulative gates, documentation and PR/CI. No production changes.

## Final implementation checkpoint

PR: https://github.com/diese-tech/Ratatoskr/pull/77
Branch: codex/b2-scout-telemetry; base: codex/b1-player-names (PR #76).

Done: Lucid source review and the adapted persistent telemetry lifecycle are
implemented. The master plan is v1.5; the operating guide explains counts,
membership changes, historical snapshots and recovery. B1 and B2 retain separate
release boundaries, and reminder scheduling remains a separate proposed feature.

Validation: 182 tests, both typechecks, build and dependency audit pass. Functional
commit ca182d6 passed Ubuntu and Windows CI in run 33713297824. Require green
checks on the final documentation checkpoint as well before integration.

Next: inspect final PR checks/review; release B1 first and then B2 under the
documented production-change gate. Rehearse migration 16 against a consistent
production copy, verify one writer/runtime/volume, and run the focused live card,
eligibility, creator notification and restart checks. No merge, deployment or
live acceptance is claimed. #68 remains open for its acceptance evidence.
