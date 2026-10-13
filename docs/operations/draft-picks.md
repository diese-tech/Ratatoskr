# Draft Picks health and approved setup

Draft tracking is an optional feature. Roster status and top-four verification are shown separately in League Ops. A clean roster audit does not prove that tracking is ready. The persisted feature observation includes its last check time; hourly panel refresh does not read Sheets or advance that time.

## Health meaning

| State | Meaning and next action |
| --- | --- |
| Ready | Expected row-5 A–J schema, 96 distinct slots across three divisions, resolved IDs and consistent identity/status ownership. |
| Partial | Incomplete seed or unresolved IDs. Known matched picks remain detectable; unmatched players are **not verified**. Review the dry run and correct column F. |
| Empty | Tab exists but has no pick rows. Review an initial seed. Empty is not proof that there are no protected picks. |
| Missing | Invalid-range response plus fresh metadata confirms that Draft Picks is absent from the configured Admin workbook. Use the approved setup below. |
| Invalid schema/range | Preserve existing rows; repair columns/identity ownership or range configuration. The reader must not reinterpret this as an absent optional tab. |
| Wrong workbook / 403 / 404 | Verify the configured Admin target and the bot's existing access. Do not create a tab in an unverified workbook or expand credentials automatically. |
| 429 / 503 / other read failure | Tracking is not verified. Existing paced reads/cooldown and durable delivery recovery remain; no hidden read retry loop is introduced. |

Health is an observation in the existing SQLite findings store under `feature:draft-picks`, not another pick database. It is excluded from roster issue counts, repair choices and the 2-minute dirty retry trigger. Fresh full startup/daily/on-demand audits check tracking; a feature warning alone does not run deep audits repeatedly. Stable health warnings log once per state/summary transition across adapters. No player data or workbook identifiers appear in health messages.

History column M records the matched draft slot, a blank for a verified unmatched player, or `Not verified: ...` for confirmed missing/empty/incomplete tracking. Renames still skip move attribution. Nonempty column M receives the existing review highlight; an unverified label is a request for staff review, not proof that a player is protected. Later approved seeding can backfill/correct labels while preserving original transaction IDs.

Only confirmed missing tracking can use the existing optional missing-tab path. Other read/schema errors prevent Draft Picks status/history writes and retain the canonical transaction's existing pending-delivery recovery semantics; they do not replay a completed roster move. Account replacement preserves original draft slot/name and move status, updates only current identity/name/status-owner joins and records `verified`, `skipped:missing-tab`, `skipped:empty-tab` or `partial:unverified-slots`. Invalid or conflicting identity/status fails before replacement writes.

## Prerequisites

1. Obtain owner approval for the concrete seed/backfill plan and a staff quiet window. Do not infer the season's draft date. Check no canonical mutation or pending notice/history is active. This script cannot take the bot's SQLite lock when run locally; Sheets before-read guards reduce drift risk, but do not replace the quiet window.
2. Back up both native workbooks, including values, formulas, formats, validation and conditional rules. Preserve the SQLite/account-replacement evidence too when relevant. Existing staff corrections, linkage JSON and move statuses must be recoverable. A changed stored draft date resets continuity and needs separate explicit approval.
3. Confirm the **Admin** workbook by privately reviewed ID and required tabs: League Teams, Current Rosters, Player Name History, Transaction History. Confirm a distinct public source workbook containing FinalizedVetting and Vanaheim/Alfheim/Svartalfheim Draft. Never publish either workbook URL/ID or service-account JSON in issues/logs.
4. Run the exact reviewed checkout with Node 24 and `npm ci`. A logged-in, already-authorized Railway CLI must be available. The implementation host currently has no Railway CLI installed; the commands below are verified against the [official CLI contract](https://docs.railway.com/cli/run), not claimed as executed locally. Do not install tools, unseal variables or create access merely to make this runbook work without the corresponding authorization.
5. Privately set `$reviewedProjectId`, `$reviewedEnvironmentId`, `$reviewedServiceId`, `$reviewedAdminId`, `$reviewedPublicId`, and the owner-confirmed `$draftDate`. Keep the existing secret supplied through the approved service context. These variables are review targets, not guessed defaults.

`railway run` executes **locally** with selected service variables; it does not SSH into production and does not mount `/data` or the production SQLite volume. This script only reads/writes Sheets, using the historical account projection already present in Draft Picks. It does not query or create a local replacement SQLite database. Sealed variables may be unavailable locally; fail closed and use a separately approved existing runtime execution path if needed. Never print/export the secret into a report or change its access policy as a workaround.

## Dry run and approval

PowerShell, from the reviewed repository checkout:

```powershell
railway run --project $reviewedProjectId --environment $reviewedEnvironmentId --service $reviewedServiceId --no-local npx --no-install tsx scripts/seed-draft-picks.ts "--since=$draftDate" "--expect-admin-id=$reviewedAdminId" "--expect-public-id=$reviewedPublicId"
```

No `--write` means no spreadsheet writes, tab creation, highlight changes or clears. The default output is private operator detail: unresolved identities, moved picks and exact history-label changes. Use `--summary-only` when collecting sanitized counts/fingerprint; do not publish the detailed output. Expect 96 picks: three divisions × eight teams × rounds 1–4; captains are not draft picks. Check source team headers against Current Rosters, unresolved/duplicate IDs, manual corrections, protected historical account links and the draft date. Retain the printed seed-plan fingerprint as `$reviewedPlan` only after approving the exact result.

For an existing table, staff may correct an unresolved Discord ID in **F** and rerun the dry run. The seed planner intentionally recomputes a status whose **J** owner no longer matches F, instead of carrying a previous person's move status. Runtime proof rejects that mismatch until the reviewed repair is applied. Account-replacement linkage JSON must still match its current F identity; a malformed/conflicting link stops seeding.

After explicit approval, rerun the same reviewed inputs:

```powershell
railway run --project $reviewedProjectId --environment $reviewedEnvironmentId --service $reviewedServiceId --no-local npx --no-install tsx scripts/seed-draft-picks.ts "--since=$draftDate" "--expect-admin-id=$reviewedAdminId" "--expect-public-id=$reviewedPublicId" "--expect-plan=$reviewedPlan" --write
```

The script requires matching reviewed workbook IDs, a real date, and the current dry-run plan hash. It rechecks source values and tab ownership before the first write. Changed inputs require a new dry run/approval. A different stored date also requires `--confirm-season-reset`; never add it without reviewing the reset. `--allow-partial` is an exceptional, separately reviewed incomplete-seed choice, not the normal workaround for a bad parse; it changes the plan fingerprint.

Writes are confined to Admin: create Draft Picks only if absent; A2/A3 explanatory text; A4:B4 draft date; A5:J5 headers; A6:J pick rows; F/J plain-text ID formats; M5 and selected Transaction History column-M annotations; moved/review highlight rules. The script writes the planned rows before clearing trailing old rows. Same-season reseeding retains manual IDs and owned move status; an approved new-season reset does not. Neither route rewrites historical transaction account IDs.

After any failed write, inspect actual managed values and the last completed phase before deciding on recovery. Sheets changes are not atomic. Do not blindly repeat an old `--write` command or replace IDs from guessed names.

## Independent production verification

After separately approved deployment, use Recheck roster and inspect the tracking reason/check timestamp. Before seeding, the confirmed missing-tab state should appear alongside independent roster health. After an approved seed, read row-5 headers, 96 slots, F/J text formats and identity/status ownership; confirm manual IDs/links/history continuity and only planned M backfill/highlights changed. Recheck tracking to see Ready or the exact unresolved reason. Do not perform a league transaction just to test this optional feature. Code/CI/review is separate from deployment and live operator acceptance; nothing auto-seeds at startup.
