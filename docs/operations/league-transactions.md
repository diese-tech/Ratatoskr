# League transaction operations

## Staff workflow

1. Run `/transaction trade`, `/transaction drop`, `/transaction self-drop`, `/transaction pickup`, `/transaction rename`, or `/transaction departure`.
2. Read the private preview. Nothing changes during preview.
3. Re-run the same command with `confirm:true` only after the approved move and detected teams are correct.
4. Keep the private queued operation reference. Confirm the public transaction notice when one is expected. Repeating the same confirmation returns the current job status without another mutation.

Ratatoskr stores the private preview by server, administrator, and exact command selections. Confirmation queues the approved intent in SQLite. One canonical worker per guild rebuilds the transaction from fresh Discord and sheet state, rechecks administrator access, and proceeds only when the plan matches the approved fingerprint. If state changed while waiting, the job becomes `BLOCKED_REVIEW` without writing. Run the matching command again to review a fresh preview, then explicitly confirm it. A preview is never queued executable state.

Only Allfather and Aesir role IDs may run these commands. Pickups accept only one of the 24 active division-suffixed team roles from **League Teams**. Plain franchise roles are leadership/advisor access and are never moved.

`/transaction departure` is specifically for a rostered player who has already left the YSL server. Its player field searches **Current Rosters** rather than Discord's live User picker. The command confirms the player is absent, removes them from the private and public active rosters, marks them `Inactive`, preserves their Discord ID and name history, and does not add them to free agency or attempt a Discord role change. A current server member must use `/transaction drop` instead.

`/transaction self-drop` is for a current member who left their team by choice. It removes the player from the active roster and team role, does not add Free Agent status, and records `Suspended - Self-Drop (Current + Next Season)`. Player Name History renders that current row red and explains the status in its legend. Ratatoskr does not assign a suspension role.

Drop, self-drop, and departure accept an optional **replacement** selected from current Discord members. The replacement must be a same-division Free Agent. When supplied, both moves are one previewed transaction and one public notice; do not run a second pickup command.

`/transaction rename player:<player> league_name:<name>` previews and explicitly confirms a requested Discord server nickname and official league name (1–32 characters). Allfather/Aesir/Valkyrie staff can use it; a separate manual nickname edit is no longer required. Ratatoskr checks its own Manage Nicknames permission and role hierarchy, preserves the original nickname/display-name state in the approved fingerprint and durable record, sets the nickname, then syncs Current Rosters, Player Name History and the public roster. Historical aliases, team/captain assignment and old transaction attribution survive. Restoring an existing official name as a nickname does not duplicate public cells or history. Syncing an already-set nickname performs no Discord nickname mutation.

The original nickname, including a missing/null nickname, is restored only after a proven pre-write Sheets failure and an exact current-state check. Uncertain nickname/Sheets writes or failed post-write verification require reconciliation; startup never replays the rename. Old previews whose plan changes must be refreshed and explicitly confirmed again. This grants no broad native Discord permissions to Valkyrie.

## Top-4 draft picks

League rules protect each captain's first four draft picks (rounds 1–4; the `Cap:` line is not a pick). Moves of those players are marked so staff can review trades for competitive balance.

- The Admin **Draft Picks** tab lists every top-four pick with its Discord ID. Use the [approved setup runbook](draft-picks.md) for targeted dry runs and guarded writes. Review unresolved/moved picks, the draft date and the plan fingerprint first. Staff-entered text IDs are retained on same-season reseeding; do not infer an unresolved identity from a similar name.
- When a confirmed transaction moves a listed player, Ratatoskr writes the pick into **Transaction History** column M (`Top-4 Pick`), sets the Draft Picks status to `Moved · <move> · <reference>` (column J records whose move it is, so correcting an ID never carries over another player's record), and posts one unpinged note in staff-ops. Conditional formatting turns both rows yellow; do not highlight roster cells by hand.
- The seed run also backfills column M for earlier history rows and marks picks that moved before tracking (`Moved · before tracking`).
- The tab records its draft date in B4 (`--since=YYYY-MM-DD`, optional for Season One). Re-runs reuse it and keep staff-entered IDs. For a new season, pass the new draft date; a different date starts the tab over so last season's IDs and move statuses are not carried over, and history before that date is ignored.
- Confirmed missing/empty/incomplete tracking is recorded as `Not verified: ...` in history, rather than silently treating unmatched players as unprotected. Other source/schema errors retain pending-delivery recovery. The staff-ops move note remains best-effort; history is the record. See [Draft Picks health and approved setup](draft-picks.md) for diagnosis, guarded dry-run/write flags and independent production validation.

## Automatic safety checks

- Every confirmed mutation runs a complete Discord/private-sheet/public-sheet audit.
- Ratatoskr runs the same read-only comparison after startup and daily at **6:00 AM America/New_York**. This requires no administrator action and follows EST/EDT automatically.
- Departure may resolve the selected player's expected absence; every unrelated absent player or other inconsistency still blocks the command.
- Every confirmed mutation re-reads the managed sheet values and player roles immediately before changing anything.
- A mismatch stops the command; Ratatoskr does not normalize or overwrite the unexpected value. It records one durable reconciliation ticket and refreshes the League Ops status panel.
- Current Rosters updates are row-targeted. Unrelated rows, internal blanks, and manually maintained cells on unrelated rows are preserved.
- Public writes are restricted to the eight seven-player team blocks and the two free-agent columns on each visible roster tab. Draft tabs are never read or written by the transaction service; only `scripts/seed-draft-picks.ts` reads them.

## Durable queue and League Ops status panel

- Confirmed transactions and repairs take priority over targeted checks, panel refreshes, dirty retries, full audits, and hourly heartbeats, in that order. Running canonical work is not preempted. Routine waiting, duplicate clicks, and audit coalescing do not generate standalone staff-ops errors.
- SQLite stores stable operation references, actor/selection intent, approvals, lifecycle, attempts, blocked reasons, and results. Jobs move through `QUEUED`, `LOADING`, `VALIDATING`, `APPLYING`, `VERIFYING`, and `COMPLETED`. Review, retry, ambiguous-write, and exhausted-failure states remain inspectable without replaying a mutation.
- Member name, managed-role, join, leave, and rejoin events compare with the last verified observation. Potential drift queues one targeted identity check after a 2.5-second burst window. Events arriving during an active check schedule a successor. The cache never authorizes a write or supplies a transaction's before-values.
- Targeted checks fetch the affected member and managed admin index tables, then only affected public roster divisions. Sheets has no server-side Discord-ID filter. These checks do not fetch the full guild or self-drop presentation metadata and never write sheets or roles.
- Known unresolved drift is rechecked every **2 minutes**, using affected identities where known. Unknown configuration/read failures can require a full check. Clean convergence cancels pending dirty retries. Startup and **6:00 AM America/New_York** remain deep full audits.
- One unpinged **League Ops Status** panel stays in staff-ops whether healthy or dirty. Confirmed events, completed transactions, and resolved findings refresh it in place. **Review issues** opens the existing private, explicitly confirmed repair flow.
- The panel reposts hourly without requiring a full audit. The new card and its stable recovery reference are persisted and confirmed before deleting the previous authoritative copy. Failed sends preserve the previous card; ambiguous delivery is located by nonce or footer reference; failed cleanup is retried without another post. Restarts restore the deadline and delivery state.
- Presentation runs separately from the canonical worker. Slow panel delivery cannot block a new roster operation. Public transaction notices and history retain their existing durable recovery guarantees and are retried through startup/dirty recovery.
- Temporary read failures retain the last verified findings and **Review issues** controls. The panel identifies Google Sheets unavailability (503) and read quota exhaustion (429); the last full-audit timestamp advances only after a completed read. Review uses retained observations, but confirmed repairs always re-read and revalidate before writing.
- Once a durable league ticket is resolved or an alerted transaction reaches a safe terminal state, presentation recovery deletes Ratatoskr's standalone staff-ops alert with that exact reference. Historical alerts are discovered in channel history; cleanup completion is persisted by migration 31 and failed deletions retry without reposting the alert. Human messages, the status panel, and unresolved or ambiguous operations are preserved.
- **Check again** requests a fresh full check. Current name differences use **Open league tools → Roster problems → View problem → Update sheets to Discord name**, followed by explicit confirmation. Discord remains the source for active names.
- **Review operations** lists interrupted audit repairs even when no current findings remain. Each preview re-reads Discord and both workbooks. **Confirm reconciled** records the administrator's acknowledgement only after the same fresh fingerprint passes a clean full check at execution. Migration 32 retains the actor and verification evidence; the old record closes as manually reconciled, without replaying its mutation or claiming its historical write succeeded. Inspect name history before confirming. Unresolved or unreadable current state blocks close-out.
- Migration 33 records clean full-audit evidence separately. Recognized legacy UUID alerts for league audit repair/review are cleaned up only when the latest completed full audit was clean and no unresolved operations remain. Alerts newer than that verification, unrelated alerts, and human messages are preserved. Cleanup retries durably after Discord deletion failures.
- League Sheets reads batch ranges per workbook and are paced at one request every two seconds. A quota response pauses subsequent reads for one minute; the failed request is not silently replayed. Writes are never automatically retried by the HTTP client.
- Interrupted pre-write work can rebuild. Interrupted role/sheet writes remain reconciliation-required unless existing durable transaction/repair records prove completion. A fresh apparently clean roster alone does not prove an ambiguous write or its history was committed.

People Directory and People History ownership remains separate under #128. No additional people-history system, external queue, parallel resource locks, or debug Discord channel is introduced.

## Discord account replacement (#154)

Account replacement continues one existing league player under a different Discord account. It is a **League Ops reconciliation operation**, not departure, self-drop, pickup, rename or trade. It preserves the existing Current Rosters row, franchise, division, team and `Captain`/`Player` status. No new slash command is registered; the private Fluxcord surface is a separate delivery.

The domain capability is `LeagueAccountReplacementService`, exposed as `createLeagueOpsRuntime(...).accountReplacement`. Its caller must use the runtime's bound guild and fresh OPERATIONS authorization (Allfather/Aesir/Valkyrie):

1. `preview(actorUserId, oldDiscordId, newDiscordId)` reads fresh guild membership, both account identities, the owned Admin/public sheet values, configured roles and Draft Picks. It performs no external or database writes. Review the returned old/new IDs, roster row/position, old name retirement, new current name, any public-name change, managed role deltas, preserved aliases/history and manual access review items.
2. `confirm({ actorUserId, oldDiscordId, newDiscordId, expectedFingerprint, approvalReference, samePlayerConfirmed: true })` records the explicit intent in the existing per-guild queue. Use the fingerprint and unique approval reference from that preview. The fingerprint binds the actor, guild, both accounts, sheet before-values, intended changes and role state. Repeated confirmations of one preview return the same durable job; a fresh preview allows a new explicit approval after a proven pre-write failure. Competing or partial account intents fail closed. Current authorization, membership, role ownership and sheet values are checked again before external writes.
3. `record(actorUserId, reference)` privately inspects the durable linkage and phase evidence. Do not publish this record or its full payload in a public Discord channel or GitHub issue.

Migration **34** adds `league_account_replacements` and links original blocked repair jobs through `league_account_replacement_evidence`. It preserves existing jobs, approvals, transactions and historical IDs. The lifecycle is `prepared` → `applying_admin` → optional `applying_public` → `applying_discord` → `verifying` → `completed`; safe pre-write failures are `failed`, while partial or ambiguous writes become `reconciliation_required`.

Pending transaction notices/history must finish before a replacement is previewed or approved. This keeps an older delivery from changing the frozen draft move status during replacement recovery. Pre-write blocked transaction attempts do not count as pending deliveries.

The sheet updates are limited to the existing roster row's Discord ID/name cells, the old authoritative name row's status, and a new current-name row. Old aliases, notes, unrelated columns and historical transaction IDs remain intact. A changed public name updates only its owned roster cell; the same name causes no public write. Post-write reads must prove exactly one new-ID current-name/roster assignment and no falsely current old-ID assignment before completion.

Only explicitly configured, editable, non-privileged team/division/Free Agent roles are adjusted. Unmapped roles and the configured captain access role are displayed for **manual review**. A roster status of `Captain` does not grant authority to copy Discord administrative roles; unrelated roles are neither copied nor stripped. Fresh full-member proof reads do not fall back to a rate-limited cached snapshot.

Roles with administrative or moderation permissions (including ban, kick and timeout) are rejected. A configured captain access role overlapping any managed league role also blocks the preview rather than treating that access as automatically transferable.

If a Draft Picks row belongs to the old ID, the replacement updates its current identity/name and status-owner join while preserving the original draft slot/name and move status. Its Match Source retains a current-ID-bound projection of historical account IDs so subsequent moves, re-seeding and historical highlight backfill preserve protected pick attribution. It never generates a roster move or rewrites past Transaction History IDs. Malformed, conflicting or manually re-bound linkage fails closed. A missing Draft Picks tab is explicitly reported as `skipped:missing-tab`; no draft data is created or claimed verified. Inspect/seed tracking separately before relying on top-four detection.

### Interrupted account replacement

Do not retry an interrupted external mutation, roll back by guessing, or dismiss the original blocked repairs. A restarted worker resumes only known pre-write intent; external phases are quarantined for explicit reconciliation. Other canonical league mutations remain blocked while a replacement has unresolved external-write evidence, even if the visible roster happens to look clean.

Use the recorded plan to inspect both IDs, Current Rosters, Player Name History, the exact public roster cell, Draft Picks joins/status and managed Discord roles. Check the durable linkage and preserved historical attribution. An operator must repair any missing or conflicting surface explicitly; the recovery capability itself performs no external writes:

- `previewRecovery(actorUserId, reference)` verifies the recorded after-values and fresh account roles. It returns a new actor/guild-bound fingerprint of the current evidence; unresolved values refuse a recovery preview.
- `confirmRecovery({ actorUserId, reference, expectedFingerprint, approvalReference, historyReviewed: true })` queues an explicit acknowledgement through the same worker. Use the fingerprint and unique approval reference returned by `previewRecovery`; duplicate clicks reuse that acknowledgement, while a fresh preview permits a new explicit attempt after a safely blocked acknowledgement. Execution rechecks authorization and the same fresh evidence before recording who reconciled the operation. It never replays Sheets/Discord writes or invents transaction history. Changed manual access or membership is visible in the fresh fingerprint; only explicitly inspected convergence may close the record.

Recovery verifies the replacement-owned after-values, active identity invariants, draft attribution/slot and managed roles. Unrelated staff-note edits do not prevent convergence; the current source fingerprint still invalidates a recovery approval if any source changes after its preview.

The retired account's current nickname is fresh audit evidence, rather than continued league-name authority. Original name/alias rows remain protected. Active league names use the same surrounding-whitespace normalization as Discord-name repairs and the managed name-history reader.

The original related `BLOCKED_REVIEW` repair jobs remain preserved and actionable evidence through subsequent clean audits. Their later disposition requires an explicit operator workflow; replacement does not replay or silently dismiss them.

### Production approval gate for account replacement

Issue #154 authorizes source implementation only. Before one live execution, a human operator must privately review the exact old/new IDs and attest that they belong to the same continuing player, verify backups of Railway SQLite and **both workbooks**, inspect the current preview and role deltas, approve once, then observe a fresh audit and verify the captain's actual access. Do not publish the private IDs or raw operational records. No deployment, production reconciliation, role/Sheet change, retry/dismissal of the original jobs, restart or automatic merge is authorized by this implementation issue.

## Required Railway variables

```text
GOOGLE_SERVICE_ACCOUNT_JSON
YSL_ADMIN_SPREADSHEET_ID
YSL_PUBLIC_SPREADSHEET_ID
ROLE_FREE_AGENT_ID
YSL_TRANSACTIONS_CHANNEL_ID
```

Keep the service-account JSON sealed. Share both workbooks with the service-account email as Editor. Do not grant domain-wide delegation.

## Failure meaning

- **Nothing changed / reconciliation ticket:** a source is malformed or Discord, the private workbook, and the public workbook disagree. Ratatoskr leaves every source untouched, records a stable `YSL-REC-...` reference, and displays it in League Ops Status. Reconcile the named surfaces manually, then retry; a clean audit resolves the ticket.
- **Failed and rolled back:** Discord rejected a role change, and Ratatoskr confirmed the original roles were restored.
- **Reconciliation required:** an external write may be partial. Do not rerun the same roster move. Use the YSL reference in Railway logs and inspect Discord, Current Rosters, Player Name History, the public division roster, and Transaction History.
- **Notice/history pending:** the roster move and sheet values are complete. Startup and dirty-state recovery retry the missing notice/history and uses the YSL reference to avoid duplicate history rows.

## Production gate

Passing tests and CI does not prove live acceptance. Before enabling staff use, back up the persistent SQLite database, deploy through migration 33 once, inspect startup recovery and the healthy persistent panel, verify queued/double-click behavior and targeted nickname/role/leave checks, observe a 2-minute dirty retry and an hourly safe repost, preview each exit type with and without a replacement, deliberately verify one unrelated safe drift and one occupied legend range produce staff-ops tickets without writes, and perform one approved controlled replacement with both sheet workbooks open. Do not run a second bot replica against the same database/guild.

Sheets presentation reads use the existing shared service-account scheduler to coalesce identical concurrent GET/batchGet requests and reuse successful results for up to three seconds, with at most 128 entries. Roster autocomplete opts into this reuse. Full snapshots, targeted reconciliation, repair confirmations, and mutation preflight remain fresh and never join cached or in-flight presentation reads. Workbook writes invalidate that workbook's reusable results before and after the request, including ambiguous failures. Errors and incomplete batch responses are not retained; the existing two-second pacing and 429 cooldown still apply. Cache for presentation, never cache for proof.

Legacy alert cleanup retains a successful scan cutoff in the existing cleanup repository. Later clean full audits scan only messages at or after that cutoff; failed deletions do not advance it. The first successful cleanup still checks the entire retained staff-ops history.


## Staff-controlled reinstatement (#183)

Use `/transaction reinstate player:<current name, old nickname, mention or Discord ID> [transaction:<exit reference>] [reason:<short optional reason>]` to preview a former player's return. Autocomplete searches Player Name History and names saved in canonical transactions, including inactive/suspended players and people who left Discord. A private paginated picker resolves multiple identities or exits; staff must choose the exact event. A missing, duplicate or conflicting History row requires reconciliation rather than a guessed match.

The compact private card shows the selected departure/drop/self-drop, historical team/division, processor, stable identity, original Sheet effective date, proposed league date, role deltas, roster/name/public projections and preserved draft provenance. The destination is the original active team and the requested roster status is **Player**. Former captain access is not automatically granted. This is a new compensating event; original transactions, dates, aliases and draft ownership remain intact.

Choose each listed advisory/exception in the menu, then **Confirm reinstatement**. Timing, current-season self-drop suspension and roster-count guidance do not deny staff authority. Approval stores the actor, actual approval time, selected exceptions, source event and optional reason in the existing durable queue. Current-season restoration never waives a next-season penalty: the original sanction and the explicit preservation decision remain in private records. A separate staff process must handle any future-season sanction decision.

The current Sheet schema stores date-only league dates. Cards and the new public notice use that exact recorded `effectiveDate`; no midnight, native Discord timestamp or elapsed-time result is invented. A verified original job completion instant may be shown separately with its own label. Until both completed instants exist, the preview says exact elapsed time is unavailable. Deleted/missing original announcements do not block review. No original Sheet date or old public post is rewritten.

Preview and confirmation are read-only externally. Actor-bound controls expire after 15 minutes; replacement, cancellation and changed fingerprints invalidate them. Repeated confirmation returns the same saved job. The worker independently checks staff access, source history, active identity, managed-role ownership, before-values and writable destinations before changing anything. A changed league date requires a new preview. At most one nonfailed compensating transaction may reserve a source exit (migration **37**); failed pre-write/rolled-back attempts remain inspectable.

Technical limitations remain firm:

- An absent player can be found and previewed, but must **rejoin before approval**. The existing transaction state machine cannot safely represent a restored roster with an unmet member/role step; Rat neither writes a split roster nor reports role restoration pending as completed.
- Seven players is advisory. An eighth entry still needs a genuinely empty owned public cell. The fixed seven-cell blocks cannot represent an actually full return; staff must resolve the layout/roster through an explicitly approved manual process, then request a fresh preview. Rat never expands managed ranges, overwrites another player or silently truncates.
- An exit already followed by another nonfailed roster action cannot be reused. Choose the latest applicable exit. Source ambiguity, duplicate active identity, drift, unrelated roster problems and incomplete earlier actions require technical resolution.

Use **Open league tools → Saved actions → Find by reference** for completed history. Original and reinstatement details show their official Sheet dates and **View linked action** controls in both directions. Historical private cards need no backfill; old public messages and original ledger rows stay immutable. The new history row records the inbound movement, source reference and approved exceptions, regardless of how role projection is represented.

Role/Sheet interruptions use existing private reconciliation; they never replay ambiguous writes. Verified roster changes whose notice/history is pending recover through the existing announcement pipeline, using the reference and exact expected reinstatement history values to prevent duplicates or false completion. Draft highlighting still follows the returning player's identity, not the vacated seat.

### Deployment and acceptance checklist

This implementation does not authorize deployment or a live roster correction.

- [ ] Human reviews the PR, policy exception wording, absent-member limitation and current dependency audit findings.
- [ ] Back up persistent SQLite and both workbooks; rehearse migration 37 on a stopped copy and verify original transaction/job/history preservation.
- [ ] Separately approve deployment and command registration; run one bot instance and inspect startup recovery.
- [ ] Read-only live preview: find the historical player without their job ID; compare original date/type/processor/team against Transaction History and private saved actions. The Manny regression is synthetic source-shaped evidence, not a live verification.
- [ ] Verify staff-only private controls, disambiguation, stale/replayed confirmations, advisory choices and linked history navigation in Discord.
- [ ] Obtain separate explicit staff approval for one exact live return. Confirm the member is present and the owned public cell is free; record policy exceptions and preserve future sanctions.
- [ ] Observe the queued job finish; independently verify roles, both rosters, aliases, original draft ownership/highlights, one linked History row, one public announcement and a fresh clean audit. Match official Sheet/public dates exactly.
- [ ] Exercise interrupted recovery in an isolated test environment; never manufacture a partial production write.
