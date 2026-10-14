# Private League Ops review (#155)

The existing rolling League Status card remains the public health summary. **Open league tools** opens an ephemeral, owner-bound Fluxcord panel for current OPERATIONS staff (Allfather, Aesir or Valkyrie). Structural ADMIN/configuration access remains Allfather/Aesir only. Existing commands, the 6 AM full audit and hourly presentation heartbeat keep their current contracts.

## Operator workflow

- **Roster problems:** paginated current findings. An absent rostered account has separate account-replacement, departure and self-drop guidance. Replacement requires the exact old/new IDs and an explicit `SAME PLAYER` ownership attestation. Departures and self-drops continue through their existing transaction commands.
- **Saved actions:** transaction, repair and account-replacement jobs, including original pre-write blocked attempts and interrupted legacy repair records. Detail shows the saved cause, action, targets, creator, timestamp, attempts, durable reference and appropriate next step. Completed records can be inspected with **Find by reference**; refresh re-reads their durable state.
- **Review changes:** a fresh read-only account replacement, managed repair or proven pre-write transaction preview. A changed finding or source fingerprint blocks execution. Original blocked transaction selections are retained, while superseded attempts cannot generate reverse trades through stale UI.
- **Confirmation:** review the preview, then type `CONFIRM` in its modal. Account replacement uses the #154 service; ordinary transactions/repairs use the existing canonical worker. UI state never performs external roster mutations.
- **Check unfinished changes:** inspect an interrupted account replacement or repair against fresh source values. Type `HISTORY REVIEWED` only after checking the original record and preserved name/history data. The worker rechecks the fingerprint before acknowledging convergence; no interrupted mutation is replayed or retroactively declared successful.

Role-repair approvals use stable target/finding/action/source identity across audit references. Equivalent active work shares one job and duplicate approval keys remain aliases of it. A fresh explicit preview can recover a proven pre-write failure; old approval keys never silently retry it. Related original repair attempts stay preserved as evidence.

## Privacy, expiry and fallback

Entry, every delivered action and canonical execution check fresh authorization and the bound guild. Another actor cannot use the private session. No raw job payload or account linkage is added to the public health card; private text uses the existing credential redactor and mention suppression.

Preview reads run as finite background tasks, releasing the interaction queue. The UI never polls or auto-redraws unattended, and slow external mutations run only in the canonical worker. Sessions expire after ten minutes, with Discord's ephemeral webhook ceiling also enforced. They do not rehydrate after restart; reopen the current status card for a new read-only view. Old modals, replaced cards and duplicate submits cannot authorize another operation.

Legacy issue/recovery views remain available as **read-only** fallback. Their old confirm controls cannot enqueue a mutation. A UI initialization failure leaves existing commands and canonical work available.

## Integration and release evidence

Fluxcord is pinned to `0.2.2`; it uses the existing Discord client through `createUiBridge` and the platform-free flow/runtime APIs. No extra bot client, slash command or environment variable is introduced. The narrowly scoped deferred-button adapter mounts only a private interaction response. No new database migration is added beyond prerequisite #154's migration 34.

Keep CI, independent review, merge, deployment and live acceptance separate. Before production use, follow the account-replacement human gate in [league-transactions.md](league-transactions.md). Today's manually repaired captain and completed trades are independent incident evidence; they do not claim that the new Fluxcord replacement workflow was live exercised.

Live smoke checklist:

1. Confirm the deployed commit, migration and one rolling staff-ops card.
2. Open the private panel as an authorized administrator; inspect original repair causes, current operation state and a completed reference.
3. Verify a non-admin, revoked administrator, stale card and expired panel cannot inspect details or enqueue work.
4. For a later controlled account replacement, independently verify backups and exact identity ownership, review the fresh plan and role boundaries, confirm once, then verify both workbooks, role/captain access, history/draft continuity and a fresh audit.
5. Leave the incident/feature live gate open until actual operator evidence is recorded. No production account transfer is performed by source implementation or CI.
