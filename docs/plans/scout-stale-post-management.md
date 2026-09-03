# Scout stale-post management follow-up

Recorded: September 3, 2026. Baseline: main `208eaf88b135d346456130626505cab4ce7c1d14`.

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
- The user's meaning of editing is being clarified (players, date/time, or both).
  Existing roster edits can be made accessible now; rescheduling is not yet part
  of this implementation checkpoint.

## Checkpoints

1. Done: reproduced missing recovered-card controls and stale cancellation display;
   added Cancel setup and confirmed-deletion cleanup handling.
   Validation: 24 focused lifecycle/cancellation tests and application typecheck pass.
   Next: published finish lifecycle, recovery and authorization tests; full gates.
2. Next: commit published management independently, then prepare one focused PR.
   Require green Ubuntu/Windows CI, merge preserving commits, leave Railway
   auto-deploy enabled, and verify deployment/startup logs before further merges.

## Live acceptance

On the new deployment, a coordinator should cancel an old open card and finish an
old published card, confirming that both public/staff posts and stored lifecycle
agree. These are user-selected production actions, not automatic cleanup by the
agent. Restart must not reopen either setup. CI and startup logs alone do not
prove these Discord interactions.
