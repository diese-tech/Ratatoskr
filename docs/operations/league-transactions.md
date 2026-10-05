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

`/transaction rename` retains its existing workflow: change the member's Discord name first, then preview and confirm syncing that name to league records. Issue #146 does not change this behavior. A separate follow-up will support an administrator-declared league name across Ratatoskr-managed surfaces, including the Discord server nickname, while preserving preview/confirm, rollback/reconciliation, and name-history safety.

## Automatic safety checks

- Every confirmed mutation runs a complete Discord/private-sheet/public-sheet audit.
- Ratatoskr runs the same read-only comparison after startup and daily at **6:00 AM America/New_York**. This requires no administrator action and follows EST/EDT automatically.
- Departure may resolve the selected player's expected absence; every unrelated absent player or other inconsistency still blocks the command.
- Every confirmed mutation re-reads the managed sheet values and player roles immediately before changing anything.
- A mismatch stops the command; Ratatoskr does not normalize or overwrite the unexpected value. It records one durable reconciliation ticket and refreshes the League Ops status panel.
- Current Rosters updates are row-targeted. Unrelated rows, internal blanks, and manually maintained cells on unrelated rows are preserved.
- Public writes are restricted to the eight seven-player team blocks and the two free-agent columns on each visible roster tab. Draft tabs are never read or written by the transaction service.

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
- League Sheets reads batch ranges per workbook and are paced at one request every two seconds. A quota response pauses subsequent reads for one minute; the failed request is not silently replayed. Writes are never automatically retried by the HTTP client.
- Interrupted pre-write work can rebuild. Interrupted role/sheet writes remain reconciliation-required unless existing durable transaction/repair records prove completion. A fresh apparently clean roster alone does not prove an ambiguous write or its history was committed.

People Directory and People History ownership remains separate under #128. No additional people-history system, external queue, parallel resource locks, or debug Discord channel is introduced.

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

Passing tests and CI does not prove live acceptance. Before enabling staff use, back up the persistent SQLite database, deploy through migration 31 once, inspect startup recovery and the healthy persistent panel, verify queued/double-click behavior and targeted nickname/role/leave checks, observe a 2-minute dirty retry and an hourly safe repost, preview each exit type with and without a replacement, deliberately verify one unrelated safe drift and one occupied legend range produce staff-ops tickets without writes, and perform one approved controlled replacement with both sheet workbooks open. Do not run a second bot replica against the same database/guild.
