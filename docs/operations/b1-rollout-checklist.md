# B1 rollout handoff

Current status: B1 is merged through c594500 and Railway startup verified.
The user authorized automatic deployment and inspection between merges; it
remains enabled. See `batch-integration.md` and plan v1.7 for current evidence.
Live interaction acceptance and a production-copy restore rehearsal remain open.
The original pre-rollout checklist below is retained for those checks and future
releases; its earlier approval assumptions do not override the user's direction.

## Reviewed stack and automated evidence

PR #70 → #71 → #72 → #73 → #74 → #75 → #76 contains B1.1–B1.7 in order.
Each depends on the preceding branch. Shared-role and error-boundary review fixes
were committed on their owning branches and merged forward through the stack.
PR #76 also holds final cumulative publication/migration checks and this handoff.

Local gates: 168 tests, both typechecks, build and dependency audit pass. Synthetic
v14 disk upgrade and file-restart recovery pass. Current CI can be checked with
`gh pr checks <number>` and the tested head with `gh pr view <number> --json headRefOid`.
All seven pre-checkpoint heads passed Ubuntu and Windows; require the final PR76
checkpoint head to pass as well. Do not interpret green checks as live acceptance.

## Prepare the production change

1. Confirm the exact final commit, Railway deployment trigger, Node 24 runtime,
   and one running bot process. Record DATABASE_PATH and its persistent volume
   without copying credentials. Inspect current main/PR state before merging.
2. Inventory managed signups/results IDs per division, historical roster message
   IDs, shared scout-ops and staff-ops bindings, and outstanding posting/publish/
   roster-update recovery. Verify access without renaming historical channels.
3. Arrange a consistent SQLite backup while writes are stopped (including the
   WAL-safe backup procedure). Open a disposable copy with the new version,
   verify migration 15 and integrity, and compare lifecycle rows and stored IDs.
   Retain the original backup and tested restore procedure. Synthetic fixtures
   are available in `src/db/scoutUpgrade.test.ts`; the real backup remains pending.
4. Obtain the production-change authorization with this concrete commit/runtime/
   backup/mapping record. Merging may trigger Railway automatically: coordinate
   the approved deployment so an intermediate slice does not restart active games.
5. Integrate the stack in dependency order, retargeting each next PR to main and
   verifying its resulting diff/checks after the preceding merge. Avoid deploying
   intermediate heads. Record the final main SHA and Railway deployment ID.

## Focused live acceptance

- Confirm startup on Node 24, migration 15, the same persistent database, and
  recovery of existing pending work. Recheck IDs/history after approved division
  repair; only the two agreed Scout channels should exist per division.
- Publish an approved test roster: one signup post and a separate roster post in
  signups, linked together. A division player can attach a screenshot in results.
  Verify an old published roster still responds in its original channel.
- Open `/scout cancel`: only authorized open/roster-ready postings are listed;
  select and confirm a test posting. Check empty lists, stale selection, and
  another division's visibility using appropriate test roles.
- On desktop and mobile, use named draft/published swap and replacement controls.
  Verify a Game 2 assignment changes only the selected slot, cross-game swaps
  affect exactly two slots, and the notice identifies the correct players/slots.
  Include long/duplicate display names. Avoid changing real participant lineups.
- Trigger an approved test failure: confirm one private response, a safe staff-ops
  report, and the matching reference in Railway logs. Confirm non-staff cannot
  view it. If reporting cannot be confirmed, the reply must point to Railway.
- Exercise approved restart recovery with a pending roster update. Verify the
  original message is repaired and the notice is not duplicated. If delivery is
  uncertain, retain pending state and follow `scout-workflow.md`.

Record each result with commit/deployment, setup/channel/message IDs, timestamp,
and pass/fail. Keep credentials and private logs out of issue comments.

## Recovery and stop conditions

Stop rollout for unexpected schema/integrity changes, missing persistent volume,
more than one writer, ambiguous channel identity, failed checks, or unresolved
material review findings. Preserve the database and pending markers for diagnosis.
Do not drop migration 15 or clear pending rows to make old code run. If a rollback
is needed, stop writers and evaluate pending updates before selecting compatible
code or the rehearsed backup restore; account for any changes since the backup.

The subsequently authorized B2 (#68 readiness telemetry) is also merged and
startup verified; see the integration record. B3 remains
the full #45/#62 acceptance pass; this focused B1 smoke does not close it. #69 and
the Scout umbrella stay open until their own acceptance requirements are verified.
