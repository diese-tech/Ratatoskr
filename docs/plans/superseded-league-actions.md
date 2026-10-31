# Resolve superseded League Ops blocked actions

## Problem and evidence

An authorized staff member's pre-write blocked drop remains in Saved actions and
the League Status unfinished count after another staff member completes its
explicitly linked retry. Execution safety recognizes the successor and disables
re-preview, but inventory still treats the original as unfinished. Actor-scoped
dismissal at enqueue time does not handle this case and can hide a same-actor
original before a retry actually succeeds.

The incident also exposed incorrect saved-error classification: the generic
recovery preamble names Player Name History, so the formatter masks a specific
departed-member audit finding as a name-history problem. Close dismisses the
private session but reads as if it might close the durable action.

## Locked decisions

- Roster changes remain authoritative through confirmed `/transaction` commands.
- Never replay the original or the successful retry, or mutate roster Sheets,
  Discord roles, transaction history, or completed delivery records for cleanup.
- Original status, error, actor and timestamps remain historical evidence.
- No schema migration, background poller, new permission, or blanket dismissal.
- No new generic resolve control that could hide uncertain or partial changes.

## Slice and implementation

One AFK implementation issue covers the complete inventory/history/card path,
wording, regressions, and deployed incident acceptance. No unresolved product
decision or additional issue dependency blocks it.

### 1. Shared read-only successor proof

Add a repository query in `src/db/repositories/leagueJobs.ts` that returns a
completed successor reference only if all of the following hold:

1. The original is a transaction in `BLOCKED_REVIEW` with valid serialized
   transaction selections.
2. The original has no canonical transaction, audit repair, account replacement,
   linked replacement evidence, or open reconciliation ticket indicating work
   that must remain reviewable.
3. A later transaction job in the same guild explicitly names this original in
   `originalBlockedReference`, has the same selections, and is `COMPLETED`.
4. Its canonical transaction is also `completed`, belongs to the same guild and
   matches the selected action kind. A worker-only completed result is not proof.

Actor identity is not part of this proof. Unlinked same-selection actions do not
resolve the original. Pending, failed, partial, mismatched, cross-guild and
evidence-bearing originals stay visible. Use this proof for unfinished and
actionable inventory; the dashboard and private panels already share these
repository entrypoints. Avoid a second count/filter implementation.

Follow explicitly linked retry chains when intervening retries also blocked
before writing. Every blocked link must independently meet the same no-mutation,
guild, exact-selection and increasing-sequence checks. A completed leaf must
still have completed canonical evidence; never skip an uncertain intermediate.

Remove enqueue-time actor-scoped dismissal of blocked transactions. Approval and
dedupe behavior remain unchanged. Only completed linked canonical work resolves
the original's outstanding presentation. Historical dismissal timestamps are not
rewritten.

### 2. Preserved history with an explicit successful reference

`LeagueOpsReviewService.operationDetail` continues to find the old record. Its
display status reads **Resolved by a later action**, points to the completed
reference, preserves the historical cause, and offers no mutation/recovery
controls. The raw original remains `BLOCKED_REVIEW` in SQLite. Resolution is a
derived presentation so already-existing wedges heal immediately with new code.

### 3. Accurate failure wording and panel closure

Strip only the recognized legacy no-change/reconciliation boilerplate before
classifying its specific cause. A departed-member audit blocker must be reported
as a rostered player who left Discord, preserving the known no-change outcome.
Keep unknown/partial outcomes conservative and redact technical/credential text.
Specific genuine name-history failures still identify Player Name History.

Rename both League Ops Close buttons to **Close panel**. This remains session
navigation, not an action acknowledgment or roster mutation.

## Regression and validation plan

First add failing regressions for the exact cross-actor linked-success wedge and
legacy departed-member error. Exercise a real SQLite schema and the review/card
services rather than a duplicate implementation of the query. Cover:

- completed linked retry by another actor; original retained and inspectable;
- same-actor enqueue/failed retry does not prematurely remove the original;
- explicit link, exact selections, guild, order and canonical completion checks;
- partial/failed/announcement-pending successors, missing canonical evidence,
  original write/replacement evidence, unresolved tickets and malformed payloads;
- no replay, no canonical writes, restart persistence, identical card/private
  unfinished results and no mutation controls on resolved history;
- the actual legacy error preamble, genuine name errors and unknown secret text;
- Close panel behavior and the real Fluxcord component payload.

Run targeted regressions, the full test suite, both typechecks, build, production
dependency audit and final diff checks. Open a linked PR and request Codex review;
address findings and require current-head CI before merge. Record local, CI,
review, merge, deployment and live evidence separately.

## Rollout and wedge acceptance

Inspect current Railway source/build/start configuration before release. Preserve
the established single-instance launcher and `/data` recovery guard packaging if
the GitHub auto-build cannot reproduce that artifact. No production configuration
or recovery asset is removed merely to deploy this code.

After the corrected release is live, open fresh private tools from the latest
League Status card. Confirm the old incident reference is absent from unfinished
actions, find it by reference, and verify it identifies its completed linked
successor with both execution controls disabled. Verify Close panel only closes
the private view. Refresh the status card and confirm the stale unfinished count
is gone, without suppressing any new unrelated issue.

Use narrowly scoped read-only hosted queries if needed to verify the original
and canonical successor are unchanged; any temporary SSH key must be removed.
An operator-facing refresh may write presentation metadata, but must not enqueue
a roster mutation. Do not repair this incident through ad hoc SQL updates.

## Rollback and completion

Rollback is redeploying the prior code/artifact. There is no data migration or
cleanup mutation to reverse; reverting can make the old stale alert visible again.
Close the implementation issue only after the actual incident passes the live
acceptance above, with evidence and any independent security findings recorded.
