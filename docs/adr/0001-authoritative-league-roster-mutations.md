# ADR 0001: Authoritative league roster mutations

Status: Accepted

## Context

YSL administrators currently repeat an approved roster move in several places: a Discord transaction notice, player roles, the private roster workbook, and the public season roster. Those copies can drift, and Discord and Google Sheets cannot participate in one database transaction.

The YSL-owned workbook remains the public presentation surface. The private **YSL League Operations — Admin** workbook supplies human-readable team-role configuration, canonical player names, current rosters, and transaction history. Discord role IDs remain the stable player/team identity.

## Decision

Ratatoskr owns the execution of approved `/transaction trade`, `/transaction drop`, `/transaction pickup`, `/transaction rename`, and `/transaction departure` commands. The administrator command is authoritative; the sheets are outputs and audit records, not a second command surface.

`drop` moves a current Discord member into their division free-agent pool. `departure` resolves a rostered player who has already left Discord: it selects the player from Current Rosters by stable Discord ID, removes the active private/public roster assignment, marks the player `Inactive`, preserves identity and name history, and performs no Discord role or free-agent mutation. The selected absence is the only full-audit exception; unrelated drift still fails closed.

Before every confirmed mutation, Ratatoskr compares all configured player team roles in Discord with Current Rosters, canonical names, visible public team blocks, and division free-agent lists. The result is recorded in SQLite for that America/New_York league day. Every transaction also revalidates the exact managed sheet values immediately before mutation.

The private preview is durable and scoped to the server, administrator, and exact command selections. Confirmation rebuilds the plan inside the serialized transaction lock and compares it with the saved preview fingerprint. A changed plan is not executed; the saved preview and private response are replaced with the current plan for a new review.

Manual sheet changes are never silently normalized. Ratatoskr updates only the roster rows and public cells owned by the approved transaction. If a manual entry makes the managed sources disagree, the command makes no changes and opens a durable, deduplicated reconciliation ticket. The ticket is delivered to the private staff-ops channel and remains retryable across restarts until delivery is confirmed. Staff reconcile the named Discord and sheet surfaces manually; the next clean full audit resolves the open ticket.

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

The message content pings the two configured team roles. The public card contains no emoji, database reference, raw audit detail, or service-account information.

Departure notices use the stored league name because the departed player is no longer a selectable Discord member:

> **Word Travels the Branches**
>
> Ratatoskr carries word from [Team].
>
> **[League Name]** leaves [Team] and the YSL server.
>
> Posted by [admin]

The message content pings the configured team role.

## Consequences

- Staff get one previewed command instead of several manual edits.
- Unexpected manual edits stop automation instead of being overwritten.
- Every confirmed mutation detects broad drift; command preflight protects the exact transaction from later drift.
- The first release intentionally rejects cross-division moves and leaves captain/staff role changes manual.
- Production rollout requires the Google service-account secret, both workbook IDs, the Free Agent role ID, and the transactions channel ID.
