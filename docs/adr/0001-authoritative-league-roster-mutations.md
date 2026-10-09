# ADR 0001: Authoritative league roster mutations

Status: Accepted

## Context

YSL administrators currently repeat an approved roster move in several places: a Discord transaction notice, player roles, the private roster workbook, and the public season roster. Those copies can drift, and Discord and Google Sheets cannot participate in one database transaction.

The YSL-owned workbook remains the public presentation surface. The private **YSL League Operations — Admin** workbook supplies human-readable team-role configuration, current player names, current rosters, and transaction history. Discord role IDs remain the stable player/team identity.

## Decision

Ratatoskr owns the execution of approved `/transaction trade`, `/transaction drop`, `/transaction self-drop`, `/transaction pickup`, `/transaction rename`, and `/transaction departure` commands. The administrator command is authoritative; the sheets are outputs and audit records, not a second command surface.

`drop` moves a current Discord member into their division free-agent pool. `departure` resolves a rostered player who has already left Discord: it selects the player from Current Rosters by stable Discord ID, removes the active private/public roster assignment, marks the player `Inactive`, preserves identity and name history, and performs no Discord role or free-agent mutation. The selected absence is the only full-audit exception; unrelated drift still fails closed.

`self-drop` is a disciplinary roster exit, not a Free Agent move. Its player picker reads Current Rosters by stable Discord ID, so staff can select a player who already left the server. It removes the active team assignment, removes the team role when the player is still present, records `Suspended - Self-Drop (Current + Next Season)` in Player Name History, and uses that explicit transaction language as the staff eligibility trigger. If the player is absent, Ratatoskr confirms that absence immediately before writing and uses the stored league name in the announcement. There is no Discord suspension role. Player Name History displays the semantic status with guarded red conditional formatting and a human-readable legend; the color is never the authoritative record.

Drop, self-drop, and departure may include one same-division Free Agent replacement. The exit and pickup share one preview fingerprint, durable transaction reference, role/sheet mutation, history append, and public notice. The vacated Current Rosters row and public team slot are reused, while the Free Agent list changes according to the exit type. The domain and transaction services remain independent of Discord component or Fluxcord session state so a later Fluxcord surface can reuse the same behavior.

Before every confirmed mutation, Ratatoskr compares all configured player team roles in Discord with Current Rosters, canonical names, visible public team blocks, and division free-agent lists. The result is recorded in SQLite for that America/New_York league day. Every transaction also revalidates the exact managed sheet values immediately before mutation.

The private preview is durable and scoped to the server, administrator, and exact command selections. Confirmation rebuilds the plan inside the serialized transaction lock and compares it with the saved preview fingerprint. A changed plan is not executed; the saved preview and private response are replaced with the current plan for a new review.

Manual sheet changes are never silently normalized. Ratatoskr updates only the roster rows and public cells owned by the approved transaction. If a manual entry makes the managed sources disagree, the command makes no changes and opens a durable, deduplicated reconciliation ticket. The ticket is delivered to the private staff-ops channel and remains retryable across restarts until delivery is confirmed. Staff reconcile the named Discord and sheet surfaces manually; the next clean full audit resolves the open ticket.

Ratatoskr also runs that full comparison after startup and every day at 6:00 AM in `America/New_York`. Scheduled audits are read-only and do not create a second synchronization authority. Drift is shown as one unpinged rolling staff-ops card: Ratatoskr posts and durably records the fresh card before deleting the previous card. Failed delivery retains the prior card; failed cleanup is retried without posting another duplicate. A clean audit removes the outstanding card and resolves its durable state. Scheduling is timezone-based so the run remains at 6:00 AM through daylight-saving changes.

The rolling card is a compact dashboard. Its **Review issues** control opens a private, one-item-at-a-time queue for league administrators. A supported repair requires an issue-specific choice and a second explicit confirmation. Confirmation reloads Discord and both workbooks, requires the exact reviewed finding to still exist, and changes only the affected managed roles, roster row, name row, or public roster block. The repair attempt and administrator are recorded durably before any write. A changed finding is rejected without writing; any possibly partial repair opens the existing staff reconciliation path. Ratatoskr then reruns the full audit and replaces or clears the rolling card. This admin-confirmed repair surface does not make the scheduled audit itself an automatic synchronization authority.

For an active rostered player or Free Agent, the current Discord display name is the authoritative current name. Name findings show the Discord value, Current Rosters value, and Player Name History value with those source labels. Staff are not asked to choose between internal sheet concepts: the confirmed repair updates the managed sheets and matching public roster to the current Discord name while retaining prior names in Player Name History. `/transaction rename` accepts only that current Discord display name and exempts only the selected player's expected name drift during its full audit; every unrelated mismatch still blocks the transaction. Discord is fetched again immediately before an audit repair writes. No name is changed without the administrator preview and confirmation.

The mutation lifecycle is durable:

1. Validate authorization, the saved preview, and current Discord/sheet state.
2. Confirm the current plan still matches the reviewed preview, then record transaction intent in SQLite.
3. Change only division-suffixed player team roles and the Free Agent role. Plain franchise roles are never part of a roster mutation.
4. Update the private and public sheets only when their audited before-values still match.
5. Verify the resulting managed sheet values.
6. Post the human-facing transaction notice.
7. Append the private transaction-history rows and mark the transaction complete.

Safe preflight failures repair Discord changes and close the attempt as failed. Once a sheet write may have occurred, Ratatoskr does not guess or blindly roll Discord backward; it records `reconciliation_required`. Completed sheet mutations whose announcement/history is interrupted remain `announcement_pending` and retry on startup. Transaction History uses the stable reference to avoid duplicate rows.

## Presentation

Trade notices use the locked public structure:

> **Word Travels the Branches**
>
> Ratatoskr carries news of an agreement between [Team 1] and [Team 2].
>
> [player1] leaves [Team 1] to join [Team 2].  
> [player2] leaves [Team 2] to join [Team 1].
>
> Posted by [admin]

The message content pings the two configured team roles and also lists present players' user mentions, unpinged (`allowedMentions` names only the roles), so Discord delivers their user data and clients can render the embed mentions. Player references in the card read `**League Name** (@mention)` so a name is visible even where a client shows a raw ID. The public card contains no emoji, database reference, raw audit detail, or service-account information.

Departure notices use the stored league name because the departed player is no longer a selectable Discord member:

> **Word Travels the Branches**
>
> Ratatoskr carries word from [Team].
>
> **[League Name]** leaves [Team] and the YSL server.
>
> Posted by [admin]

The message content pings the configured team role.

Combined exit/replacement notices keep the same title, lead, footer, and single team-role ping. Their transaction line is explicit:

> [Team] drops [outgoing player] into free agency and picks up [replacement].

> [outgoing player] self-drops from [Team]. [Team] picks up [replacement] in their place.

> **[departed league name]** leaves [Team] and the YSL server. [Team] picks up [replacement] in their place.

A standalone self-drop uses the same self-drop sentence without the replacement sentence. Existing standalone drop and departure wording remains unchanged.

## Consequences

- Staff get one previewed command instead of several manual edits.
- Unexpected manual edits stop automation instead of being overwritten.
- Every confirmed mutation detects broad drift; command preflight protects the exact transaction from later drift.
- Startup and daily audits surface drift before staff need the next transaction while keeping only one authoritative audit card in staff-ops.
- The first release intentionally rejects cross-division moves and leaves captain/staff role changes manual.
- Production rollout requires the Google service-account secret, both workbook IDs, the Free Agent role ID, and the transactions channel ID.

## Amendment: durable league operations (#146)

The guild fail-fast gate and exception-only rolling card are superseded by a durable SQLite intent queue and persistent League Ops status panel. One canonical worker per guild serializes transactions, explicitly confirmed repairs, targeted verification, and deep audits. Database claims prevent another worker instance from starting canonical work for the same guild while a job is active. A separate presentation lane edits/reposts the panel without holding canonical work.

Each preview delivery receives a durable approval reference. Repeated equivalent active approvals and confirmations alias one job; completed approval keys are retained to prevent stale clicks from mutating twice. Execution rechecks administrator access, reloads sources, rebuilds the approved intent, and compares its fingerprint. Changed plans block for a refreshed preview. Existing transaction/repair records continue to govern rollback, ambiguous writes, public notices, and history recovery. Job recovery cannot blindly replay an interrupted external mutation.

Verified per-Discord-ID observations are drift detectors, never mutation authority. Member events coalesce targeted checks; resource findings are replaced in place and aggregated across independent identities. Known dirty resources retry every two minutes until fresh checks converge. Full startup and 6 AM New York audits remain. Hourly panel repost is presentation only, persists its payload/reference, confirms the new authoritative card before cleanup, and recovers ambiguous delivery by nonce or footer reference. The panel remains present when healthy.

Resource-scoped mutation parallelism, a technical Discord channel, and generalized/external queue infrastructure remain deferred. People Directory/History work remains owned by #128.
