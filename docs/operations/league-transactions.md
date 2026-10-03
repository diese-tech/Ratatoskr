# League transaction operations

## Staff workflow

1. Run `/transaction trade`, `/transaction drop`, `/transaction self-drop`, `/transaction pickup`, `/transaction rename`, or `/transaction departure`.
2. Read the private preview. Nothing changes during preview.
3. Re-run the same command with `confirm:true` only after the approved move and detected teams are correct.
4. Confirm the private completion reference and the public transaction notice when one is expected.

Ratatoskr stores the private preview by server, administrator, and exact command selections. Confirmation proceeds only when the freshly rebuilt transaction is identical to that preview. If league state changed, Ratatoskr makes no transaction changes, replaces the saved preview, and shows the administrator the updated move to review before trying again.

Only Allfather and Aesir role IDs may run these commands. Pickups accept only one of the 24 active division-suffixed team roles from **League Teams**. Plain franchise roles are leadership/advisor access and are never moved.

`/transaction departure` is specifically for a rostered player who has already left the YSL server. Its player field searches **Current Rosters** rather than Discord's live User picker. The command confirms the player is absent, removes them from the private and public active rosters, marks them `Inactive`, preserves their Discord ID and name history, and does not add them to free agency or attempt a Discord role change. A current server member must use `/transaction drop` instead.

`/transaction self-drop` is for a current member who left their team by choice. It removes the player from the active roster and team role, does not add Free Agent status, and records `Suspended - Self-Drop (Current + Next Season)`. Player Name History renders that current row red and explains the status in its legend. Ratatoskr does not assign a suspension role.

Drop, self-drop, and departure accept an optional **replacement** selected from current Discord members. The replacement must be a same-division Free Agent. When supplied, both moves are one previewed transaction and one public notice; do not run a second pickup command.

## Automatic safety checks

- Every confirmed mutation runs a complete Discord/private-sheet/public-sheet audit.
- Departure may resolve the selected player's expected absence; every unrelated absent player or other inconsistency still blocks the command.
- Every confirmed mutation re-reads the managed sheet values and player roles immediately before changing anything.
- A mismatch stops the command; Ratatoskr does not normalize or overwrite the unexpected value. It records one durable reconciliation ticket and alerts staff-ops.
- Current Rosters updates are row-targeted. Unrelated rows, internal blanks, and manually maintained cells on unrelated rows are preserved.
- Public writes are restricted to the eight seven-player team blocks and the two free-agent columns on each visible roster tab. Draft tabs are never read or written by the transaction service.

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

- **Nothing changed / reconciliation ticket:** a source is malformed or Discord, the private workbook, and the public workbook disagree. Ratatoskr leaves every source untouched, records a stable `YSL-REC-...` reference, and alerts staff-ops. Reconcile the named surfaces manually, then retry; a clean audit resolves the ticket.
- **Failed and rolled back:** Discord rejected a role change, and Ratatoskr confirmed the original roles were restored.
- **Reconciliation required:** an external write may be partial. Do not rerun the same roster move. Use the YSL reference in Railway logs and inspect Discord, Current Rosters, Player Name History, the public division roster, and Transaction History.
- **Notice/history pending:** the roster move and sheet values are complete. Restart recovery retries the missing notice/history and uses the YSL reference to avoid duplicate history rows.

## Production gate

Passing tests and CI does not prove live acceptance. Before enabling staff use, back up the persistent SQLite database, deploy through migration 26 once, inspect startup logs, preview each exit type with and without a replacement, deliberately verify one unrelated safe drift and one occupied legend range produce staff-ops tickets without writes, and perform one approved controlled replacement with both sheet workbooks open. Do not run a second bot replica against the same database/guild.
