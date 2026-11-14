# ADR 0001: Shared Discord member reads for league operations

- **Status:** Accepted (documents the established #156 implementation and the #186 fix)
- **Recorded:** 2026-11-02
- **Scope:** Guild-wide Discord member reads used by Ratatoskr league operations
- **Implementation:** [#186](https://github.com/diese-tech/Ratatoskr/issues/186) fixed by [PR #188](https://github.com/diese-tech/Ratatoskr/pull/188); the same no-change cooldown handling was applied to `/transaction` previews in [PR #190](https://github.com/diese-tech/Ratatoskr/pull/190)

## Context

League audits, roster transactions, account replacements, and staff previews sometimes require a complete current Discord guild-member snapshot. A whole-guild `guild.members.fetch()` uses Discord Gateway member requests, which have their own throttling semantics, separate from REST 429 and Google Sheets quotas.

Ratatoskr already has a shared coordinator in `src/services/leagueMemberReads.ts` (developed in [#156](https://github.com/diese-tech/Ratatoskr/issues/156)). It coalesces concurrent equivalent reads across adapters for the same guild/Gateway session, handles bounded read-only observation snapshots and invalidation, and respects Gateway `retry_after` with a limited interactive wait.

On November 2, 2026, `/transaction reinstate` performed one full read in `LeagueReinstatementService.open()` and another sequential read in `preview()`. In-flight sharing does not deduplicate **sequential** reads. Discord returned a cooldown before any transaction was queued or mutation started, while generic failure reporting incorrectly warned staff that writes or an announcement might have occurred. See [#186](https://github.com/diese-tech/Ratatoskr/issues/186).

## Decision

1. **One canonical coordinator.** Use `readLeagueMembers` through `DiscordLeagueGateway.getMembers()` for full member reads. Do not add parallel caches, guild-read schedulers, retry loops, or direct uncoordinated whole-guild `guild.members.fetch()` paths in league features. Targeted fresh member reads are permitted when correctness calls for them.
   - **Maintenance-script exception (approved 2026-11-04, [#196](https://github.com/diese-tech/Ratatoskr/issues/196); extended to approved writes in [#199](https://github.com/diese-tech/Ratatoskr/issues/199)).** A script in `scripts/`, run outside the bot, may list members once using paginated Discord REST `GET` requests. This path never logs in to the Gateway, so it cannot trigger the Gateway member-request throttle the coordinator protects against, and it shares no state with the bot.
     - **Why:** the owner uses these scripts to gather or correct league data without waiting for a bot release. They also keep that one-off work away from the bot's own member reads and job queue, so the bot doesn't stumble on it.
     - **Writes:** the script may write (Sheets, or Discord) when the owner approves that run, whether the owner runs it or asks an agent to. A writing run must:
       - be planned by a staff-reviewed dry run;
       - re-read its sources immediately before writing, and stop without writing if they changed;
       - respect Discord and Google rate limits;
       - leave nothing that stops the bot from starting or operating normally afterwards;
       - report exactly what it wrote, never suggesting a blind replay.
     - **Enforcement:** bot runtime code must not import these scripts. `src/services/divisionInspection.test.ts` enforces this for the division inspection and the division import.
     - **Scope:** the exception does not cover bot features, commands or background jobs. Those keep using the coordinator and decision 3.
2. **Re-use a single verified read-only snapshot inside a logical preview.** Pass a validated complete loaded member/Sheet snapshot from initial search to initial preview where equivalent, rather than performing consecutive whole-guild requests. For later read-only redraws within the same review (for example a source picker choice or a policy-exception toggle), request the coordinator's bounded observation snapshot (`getMembers({ observation: true })`). It is reused only while recent and unchanged: it expires after the coordinator's TTL and is invalidated by member, role, guild and shard events, after which one fresh complete read occurs. Observation data may redraw a preview but never stands in for the fresh confirmation read (decision 3).
3. **Mutation authority is separate.** Never authorize a write from a presentation cache, saved card, stale or incomplete list. Confirmation and the serialized mutation worker must retain the intended fresh validation of authorization, member identity/managed roles, workbook before-values, original transaction history, deterministic fingerprint, and current snapshot. Drift refuses execution.
4. **Honor the returned cooldown.** Distinguish Discord Gateway member-request throttling from Discord REST and Sheets quota responses. Use the existing coordinator's bounded wait and actual `retry_after`, not guessed fixed delays; avoid aggressive automatic retries.
5. **Tell the truth about operation phase.** Before enqueue/external mutation, a read-only throttle is a no-write deferral: show an actionable private cooldown message and explicitly state no roster, role, Sheet, or announcement change occurred. Do not raise a generic "partial transaction" staff incident when a write was impossible. Preserve durable reconciliation and staff alerts for genuinely uncertain post-confirmation/post-write states.
6. **Keep operations and scope intact.** Preserve 6 AM ET audits, queued league reconciliation, priority rules, recovery state, and background observation. A feature must not invent a second coordination system to work around the existing one.

## Consequences

- New league features have an explicit integration seam and reviewable performance/safety contract.
- Tests must cover number of whole-guild requests for multi-stage read-only flows, Gateway cooldown, snapshot invalidation, fresh confirmation/worker proof, and distinguish no-write failures from ambiguous partial writes.
- Sharing read-only state is only a latency and rate-limit improvement; it does not relax approval or execution validation.
- The #186 reinstatement fix shipped in PR #188 (snapshot reuse, observation redraws, private pre-write cooldown replies). PR #190 extended the private cooldown reply to ordinary `/transaction` previews. Live observation after deployment is tracked separately from this record.

## Related source and records

- `AGENTS.md` — agent-facing implementation rule
- `src/services/leagueMemberReads.ts` — established shared coordinator
- `src/services/leagueReinstatement.ts` — follow-up integration fix
- `src/services/interactionErrors.ts` and `src/services/operationalErrors.ts` — accurate phase-aware reporting
- [#156](https://github.com/diese-tech/Ratatoskr/issues/156) — established member-fetch coalescing
- [#183](https://github.com/diese-tech/Ratatoskr/issues/183) and [PR #185](https://github.com/diese-tech/Ratatoskr/pull/185) — reinstatement workflow
- [#186](https://github.com/diese-tech/Ratatoskr/issues/186) — production regression, fixed by [PR #188](https://github.com/diese-tech/Ratatoskr/pull/188)
- [PR #190](https://github.com/diese-tech/Ratatoskr/pull/190) — private cooldown reply for `/transaction` previews

## Amendment: confirmation and execution validation (2026-11-13)

Status: Accepted by the owner for documentation only. This amendment is authoritative over Decision 3's universal confirmation-time fresh-source wording, Decision 2's reference to a fresh confirmation read, and the original mutation ADR's confirmation-time plan-rebuild wording. Historical text remains intact. It does not weaken execution validation or authorize runtime changes.

- Confirmation freshly authorizes the actor and validates the reviewed intent, approval identity, workflow validity and required acknowledgements before accepting new work. Acceptance and preview lifetime follow the [mutation ADR's durable-acceptance amendment](0001-authoritative-league-roster-mutations.md#amendment-preview-lifetime-and-durable-acceptance-2026-11-13).
- A second complete Discord/Sheets read at confirmation is not universally required when the canonical serialized worker independently validates fresh authoritative sources before mutation. Reinstatement retains its existing stronger confirmation-time validation, including fresh source/history, fingerprint, date and policy-exception checks. A queued acknowledgement is not a claim that execution checks passed.
- Worker execution rechecks authorization, reconstructs the approved intent from fresh authoritative sources, and validates its fingerprint, relevant identities, managed roles, original history where applicable, and managed before-values. Changed or unavailable proof refuses mutation; presentation caches and observation snapshots never authorize writes.
- The approving actor is freshly reauthorized at the guarded pre-write boundary after substantive asynchronous validation and before the first external write. This supplements worker-entry authorization; it does not replace source or before-value checks or promise atomicity between Discord, Sheets and SQLite.
- Authorization failure before any external write produces no mutation. Once a write may have occurred, failure or revocation preserves durable phase evidence and the existing guarded compensation/reconciliation requirements. Never relabel an uncertain write as a no-change failure or blindly replay it. Recovery acknowledgements revalidate authorization and current evidence before recording closure; they cannot replay interrupted mutations or retroactively prove the original write succeeded.
- All complete-guild reads continue through the existing coordinator under Decision 1, including its unchanged maintenance-script exception. Read-only snapshot reuse, actual Gateway cooldown handling, phase-accurate failure reporting, scheduled audits and queue priorities remain unchanged. Tests must distinguish confirmation checks from authoritative worker proof and preserve reinstatement's stronger checks.

This is the required contract, not a claim that every current write path already has the final authorization check. Any implementation gap needs separately authorized work; this amendment changes documentation only.
