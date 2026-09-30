# League transaction operations

## Staff workflow

1. Run `/transaction trade`, `/transaction drop`, `/transaction pickup`, or `/transaction rename` with the Discord player selections.
2. Read the private preview. Nothing changes during preview.
3. Re-run the same command with `confirm:true` only after the approved move and detected teams are correct.
4. Confirm the private completion reference and the public transaction notice when one is expected.

Only Allfather and Aesir role IDs may run these commands. Pickups accept only one of the 24 active division-suffixed team roles from **League Teams**. Plain franchise roles are leadership/advisor access and are never moved.

## Automatic safety checks

- The first confirmed mutation each league day runs a complete Discord/private-sheet/public-sheet audit.
- Every confirmed mutation re-reads the managed sheet values and player roles immediately before changing anything.
- A mismatch stops the command; Ratatoskr does not normalize or overwrite the unexpected value.
- Current Rosters is rewritten in league order: Vanaheim, Alfheim, Svartalfheim.
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

- **Nothing changed / run again:** a before-value drifted or validation failed. Inspect Discord and the named sheet; decide which source is correct before retrying.
- **Failed and rolled back:** Discord rejected a role change, and Ratatoskr confirmed the original roles were restored.
- **Reconciliation required:** an external write may be partial. Do not rerun the same roster move. Use the YSL reference in Railway logs and inspect Discord, Current Rosters, Player Name History, the public division roster, and Transaction History.
- **Notice/history pending:** the roster move and sheet values are complete. Restart recovery retries the missing notice/history and uses the YSL reference to avoid duplicate history rows.

## Production gate

Passing tests and CI does not prove live acceptance. Before enabling staff use, back up the persistent SQLite database, deploy migration 21 once, inspect startup logs, run one controlled preview, and perform a reversible live transaction with both sheet workbooks open. Do not run a second bot replica against the same database/guild.
