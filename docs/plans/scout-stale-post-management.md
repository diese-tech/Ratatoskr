# Scout stale-post management follow-up

Recorded: September 3, 2026. Baseline: main `208eaf88b135d346456130626505cab4ce7c1d14`.

Implementation merged in [PR #79](https://github.com/diese-tech/Ratatoskr/pull/79)
at `cd1be71284fafc7c69d0058807d046889101238d`. Checkpoints `8777d03` and `3ba4306`
are preserved. All 196 tests and local gates pass; PR CI `33758762949` and main CI
`33758944912` passed Windows and Ubuntu. Railway deployment
`ba9e274e-fe5c-49ea-bd29-c632709f1463` succeeded at 13:06:58 UTC. Inspected logs show
database readiness, bot login, command registration, finished-post reconciliation
at 13:07:00 and card reconciliation at 13:07:07, with no startup failures.
Auto-deploy remains enabled. Live cancellation/completion acceptance is pending.

The user verified that B2 recovered older Scout Ops listings, then reported that
those cards offer no way to edit or close the underlying setup. This is a bounded
B2 follow-up before B3 acceptance, not authorization for the remaining backlog.

## Revised contract

- Open signup cards, including recovered past-dated cards, expose **Cancel setup**.
  Reuse the existing authorized, private confirmation and durable cancellation.
  `/scout cancel` remains available and includes old open/roster-ready setups.
- A cancelled card reflects stored cancellation even when public cleanup fails.
  Confirmed deleted messages/channels count as cleanup complete; access and
  transport failures remain pending. Preserve signup history and final counts.
- Published cards expose roster management and **Finish scout**. Finishing is an
  explicit staff decision: preserve roster/history, record who finished it and
  when, disable further player changes, and reconcile existing posts durably.
  Pending publication or roster updates must finish before a scout can finish.
- Never auto-close by date, delete records, move historical rosters, or post
  reminders. Existing signup/results channel ownership remains unchanged.
- Roster player edits are available from Scout Ops. Clarification is still
  needed on whether editing should also include date/time rescheduling.

## Current next steps

Complete the user-selected live cancel/finish acceptance described below and the
outstanding production-copy restore rehearsal. Clarify whether date/time
rescheduling is needed. CI, merge and deployment/startup checks for the recorded
implementation are complete; they are not pending prerequisites for this work.

## Historical implementation checkpoints

These snapshots preserve the work and validation recorded at each implementation
commit. Their Next entries describe the next step at that time, not current work.
Use Current next steps above when resuming.

1. Done: reproduced missing recovered-card controls and stale cancellation display;
   added Cancel setup and confirmed-deletion cleanup handling.
   Validation: 24 focused lifecycle/cancellation tests and application typecheck pass.
   Next at that time: published finish lifecycle, recovery and authorization tests; full gates.
2. Done: add migration 17 completion records, versioned finish confirmation,
   startup/manual cleanup recovery, and published Swap/Replace controls in Scout
   Ops. Finished records fence both database mutations and stale private controls.
   Pending cleanup blocks division teardown. Original legacy roster routing is
   preserved, including cross-game swaps and replacements from Scout Ops.
   Validation: full local suite, both typechecks, build and production dependency
   audit pass; disk upgrade fixtures cover v14, v15 and v16; live acceptance pending.
   Next at that time: green Ubuntu/Windows PR CI, merge preserving commits, leave Railway
   auto-deploy enabled, and verify deployment/startup logs before further merges.

## Persistence and recovery

Migration 17 only adds `scout_completions`; it does not rewrite existing setup,
signup, roster, readiness or pending-update rows. A completion is keyed by setup
ID with actor/time and a pending post-cleanup flag. The original `published`
status remains the publication history; the completion row closes its lifecycle.
Finishing increments the setup version in the same transaction. Further roster
mutations and overlap listings explicitly exclude completed setups.

Discord cleanup edits only persisted signup/roster message IDs and never sends a
replacement public post. A lost edit response is idempotently retried. Only
Discord Unknown Message/Unknown Channel confirms absence. Access failures keep
cleanup pending and expose a Retry post cleanup button while the setup remains
finished. Original readiness counts stay frozen. This is process completion,
not match-score reporting or a season/archive subsystem.

After the first scout has been finished, an application rollback must preserve
completion checks; older code ignores completion records and could re-enable
roster edits. Do not remove completion records to enable a rollback. A consistent
production-copy backup/restore rehearsal remains a separate unverified gate.

## Live acceptance

On the new deployment, a coordinator should cancel an old open card and finish an
old published card, confirming that both public/staff posts and stored lifecycle
agree. These are user-selected production actions, not automatic cleanup by the
agent. Restart must not reopen either setup. CI and startup logs alone do not
prove these Discord interactions.
