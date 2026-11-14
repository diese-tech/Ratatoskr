# Private League Ops review (#155)

For deployed P1–P5 acceptance, use the [clean-card read-only smoke checklist](production-release.md#clean-card-human-smoke-checklist). [ADR 0003](../adr/0003-backup-policy-and-accepted-operational-risk.md) records the owner's accepted backup risk; no backup creation, live transaction or manufactured finding is required for read-only acceptance.

The rolling League Status card is a compact snapshot: roster problem and unfinished-action counts, one draft-health line, and the time of the last full roster check. Diagnostic text, references and individual check times are private under **Check details**. **Open league tools** (or **Review problems** when attention is needed) opens an ephemeral, owner-bound Fluxcord panel for current OPERATIONS staff (Allfather, Aesir or Valkyrie). Structural ADMIN/configuration access remains Allfather/Aesir only. Existing commands, the 6 AM full audit and hourly presentation heartbeat keep their current contracts.

The staff-ops card has two controls: **Open league tools** opens private tools where staff can approve changes; **Check again** only checks for problems and makes no roster changes. Times are displayed in Eastern time with EST or EDT as appropriate.

The old read-only issue/recovery routes remain compatible with existing messages. New cards use the private tools rather than duplicate read-only buttons.

Niflheim is a layered division: a Niflheim team membership sits on top of the player's Svartalfheim record (see [ADR 0002](../adr/0002-layered-niflheim-membership.md)). The old `ROLE_NIFLHEIM_FREE_AGENT_ID` setting is no longer used. If it is still set, the bot ignores it and logs one warning; remove it from Railway after this change is deployed.

Normal roster moves start with an approved `/transaction` action. The bot updates Discord, the roster sheets and history for that action, then verifies the results. Routine checks report disagreements without automatically changing either side. **Set Discord roles from roster sheets** is a repair for an already-correct sheet assignment, not a new roster move.

## Operator workflow

- **Roster problems:** paginated current findings. An absent rostered account has separate account-replacement, departure and self-drop guidance. Replacement requires the exact old/new IDs and an explicit `SAME PLAYER` ownership attestation. Player left the league and Player self-dropped open contextual canonical transaction previews for the exact selected player. The optional replacement field accepts an exact Discord ID or may be left blank; canonical same-division/free-agent rules still apply. Existing transaction commands remain available.
- **Saved actions:** transaction, repair and account-replacement jobs, including original pre-write blocked attempts and interrupted legacy repair records. Detail shows the saved cause, action, targets, creator, timestamp, attempts, durable reference and appropriate next step. Completed records can be inspected with **Find by reference**; **Reload saved status** re-reads their durable state.
- **Review changes:** a fresh read-only account replacement, managed repair or proven pre-write transaction preview. A changed finding or source fingerprint blocks execution. Original blocked transaction selections are retained, while superseded attempts cannot generate reverse trades through stale UI.
- **Confirmation:** review the preview, choose the button named for the change, then type `CONFIRM` in its modal. Account replacement uses the #154 service; ordinary transactions/repairs use the existing canonical worker. UI state never performs external roster mutations.
- **Check unfinished changes:** inspect an interrupted account replacement or repair against fresh source values. Type `HISTORY REVIEWED` only after checking the original record and preserved name/history data. The worker rechecks the fingerprint before acknowledging convergence; no interrupted mutation is replayed or retroactively declared successful.

Role-repair approvals use stable target/finding/action/source identity across audit references. Equivalent active work shares one job and duplicate approval keys remain aliases of it. A fresh explicit preview can recover a proven pre-write failure; old approval keys never silently retry it. Related original repair attempts stay preserved as evidence.

## Privacy, expiry and fallback

Entry, every delivered action and canonical execution check fresh authorization and the bound guild. Another actor cannot use the private session. No raw job payload or account linkage is added to the public health card; private text uses the existing credential redactor and mention suppression.

Preview reads run as finite background tasks, releasing the interaction queue. The UI never polls or auto-redraws unattended, and slow external mutations run only in the canonical worker. Sessions expire after ten minutes, with Discord's ephemeral webhook ceiling also enforced. They do not rehydrate after restart; reopen the current status card for a new read-only view. Old modals, replaced cards and duplicate submits cannot authorize another operation.

Unconfirmed previews in these Fluxcord sessions are temporary. Their approval identity becomes durable when confirmation creates a canonical job or durable alias, before external mutation is eligible. That commit establishes acceptance even if the Discord acknowledgement is lost. Closing, expiring or reopening a panel cannot cancel, renew or erase accepted work; a new session must not inherit an old approval. Inspect Saved actions after an uncertain acknowledgement. Confirmation checks fresh actor access, reviewed intent and workflow validity; authoritative source validation remains in the worker. This does not change persisted ordinary transaction previews or reinstatement reviews and their stronger confirmation-time validation. See the [approved ADR amendments](../adr/0001-authoritative-league-roster-mutations.md#amendment-preview-lifetime-and-durable-acceptance-2026-11-13).

Legacy issue/recovery views remain available as **read-only** fallback. Their old confirm controls cannot enqueue a mutation. A UI initialization failure leaves existing commands and canonical work available.

## Integration and release evidence

Fluxcord is pinned to `0.2.2`; it uses the existing Discord client through `createUiBridge` and the platform-free flow/runtime APIs. No extra bot client, slash command or environment variable is introduced. The narrowly scoped deferred-button adapter mounts only a private interaction response. No new database migration is added beyond prerequisite #154's migration 34.

Keep CI, independent review, merge, deployment and live acceptance separate. Before production use, follow the account-replacement human gate in [league-transactions.md](league-transactions.md). Today's manually repaired captain and completed trades are independent incident evidence; they do not claim that the new Fluxcord replacement workflow was live exercised.

Live smoke checklist:

1. Confirm the deployed commit, migration and one rolling staff-ops card.
2. Open the private panel as an authorized administrator; inspect original repair causes, current operation state and a completed reference.
3. Verify an actor without OPERATIONS access, stale card and expired panel cannot inspect details or enqueue work. Valkyrie is authorized OPERATIONS staff; do not confuse it with structural ADMIN access. Revocation tests needing role changes require separate authorization.
4. For a separately approved controlled account replacement, record available recovery evidence and the accepted backup risk under ADR 0003, independently verify exact identity ownership, review the fresh plan and role boundaries, confirm once, then verify both workbooks, role/captain access, history/draft continuity and a fresh audit. This is separate from read-only acceptance.
5. Leave the incident/feature live gate open until actual operator evidence is recorded. No production account transfer is performed by source implementation or CI.

## Reloading saved status

**Reload saved status** loads persisted findings and saved action status. It does not request a new Discord/Sheets audit or start a new review session. **Check again** on the public League Status card remains the separate explicit audit request.

Reload preserves a selected issue only when its key, finding and eligibility remain unchanged; a changed or removed issue is cleared without selecting another. Selected saved actions are looked up by their original reference, including completed actions. Unconfirmed previews and ownership attestations are cleared on every reload: persisted status alone cannot establish that their source fingerprint remains current. Request a new preview before approving. Pending modal submissions are invalidated even when the same screen remains visible. Accepted durable approvals, saved jobs and the one-fix-per-panel lock are never cleared or renewed by reload. Execution still validates fresh sources and authorization.

## Accepted actions and contextual exits

Choosing Player left the league or Player self-dropped changes nothing. The selected roster identity is carried into the existing transaction intent builder; the preview shows inactive versus current-and-next-season suspension, affected memberships, public roster changes, and any replacement. Only explicit CONFIRM accepts the exact reviewed fingerprint into the canonical queue. A fresh source check refuses a contextual exit if the player has rejoined. Departure and self-drop end both Svartalfheim/Niflheim memberships; account replacement remains a separate SAME PLAYER workflow. Source drift, access changes and occupied/invalid destinations still block through the canonical services and worker.

After durable acceptance, the private preview becomes an acknowledgement showing the saved reference and status at acceptance. Acceptance is not proof of completed execution. View submitted action loads its persisted current status without another mutation; Reload saved status also remains read-only. The panel stays locked to one accepted action across every screen. Closing never cancels accepted work. Open another independent review only from the main button on the latest League Status card; no session or approval is transferred automatically. If acknowledgement delivery is uncertain, inspect Saved actions rather than submitting the move again.
