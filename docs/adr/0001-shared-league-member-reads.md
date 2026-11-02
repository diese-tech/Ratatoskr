# ADR 0001: Shared Discord member reads for league operations

- **Status:** Proposed (documents the established #156 implementation; pending documentation PR review)
- **Recorded:** 2026-11-02
- **Scope:** Guild-wide Discord member reads used by Ratatoskr league operations
- **Implementation follow-up:** [#186](https://github.com/diese-tech/Ratatoskr/issues/186) (the specific reinstatement regression remains unfixed)

## Context

League audits, roster transactions, account replacements, and staff previews sometimes require a complete current Discord guild-member snapshot. A whole-guild `guild.members.fetch()` uses Discord Gateway member requests, which have their own throttling semantics, separate from REST 429 and Google Sheets quotas.

Ratatoskr already has a shared coordinator in `src/services/leagueMemberReads.ts` (developed in [#156](https://github.com/diese-tech/Ratatoskr/issues/156)). It coalesces concurrent equivalent reads across adapters for the same guild/Gateway session, handles bounded read-only observation snapshots and invalidation, and respects Gateway `retry_after` with a limited interactive wait.

On November 2, 2026, `/transaction reinstate` performed one full read in `LeagueReinstatementService.open()` and another sequential read in `preview()`. In-flight sharing does not deduplicate **sequential** reads. Discord returned a cooldown before any transaction was queued or mutation started, while generic failure reporting incorrectly warned staff that writes or an announcement might have occurred. See [#186](https://github.com/diese-tech/Ratatoskr/issues/186).

## Decision

1. **One canonical coordinator.** Use `readLeagueMembers` through `DiscordLeagueGateway.getMembers()` for full member reads. Do not add parallel caches, guild-read schedulers, retry loops, or direct uncoordinated whole-guild `guild.members.fetch()` paths in league features. Targeted fresh member reads are permitted when correctness calls for them.
2. **Re-use a single verified read-only snapshot inside a logical preview.** Pass a validated complete loaded member/Sheet snapshot from initial search to initial preview where equivalent, rather than performing consecutive whole-guild requests. For later interactions, avoid unnecessary reads where possible, but do not assume earlier source state remains valid indefinitely.
3. **Mutation authority is separate.** Never authorize a write from a presentation cache, saved card, stale or incomplete list. Confirmation and the serialized mutation worker must retain the intended fresh validation of authorization, member identity/managed roles, workbook before-values, original transaction history, deterministic fingerprint, and current snapshot. Drift refuses execution.
4. **Honor the returned cooldown.** Distinguish Discord Gateway member-request throttling from Discord REST and Sheets quota responses. Use the existing coordinator's bounded wait and actual `retry_after`, not guessed fixed delays; avoid aggressive automatic retries.
5. **Tell the truth about operation phase.** Before enqueue/external mutation, a read-only throttle is a no-write deferral: show an actionable private cooldown message and explicitly state no roster, role, Sheet, or announcement change occurred. Do not raise a generic "partial transaction" staff incident when a write was impossible. Preserve durable reconciliation and staff alerts for genuinely uncertain post-confirmation/post-write states.
6. **Keep operations and scope intact.** Preserve 6 AM ET audits, queued league reconciliation, priority rules, recovery state, and background observation. A feature must not invent a second coordination system to work around the existing one.

## Consequences

- New league features have an explicit integration seam and reviewable performance/safety contract.
- Tests must cover number of whole-guild requests for multi-stage read-only flows, Gateway cooldown, snapshot invalidation, fresh confirmation/worker proof, and distinguish no-write failures from ambiguous partial writes.
- Sharing read-only state is only a latency and rate-limit improvement; it does not relax approval or execution validation.
- This ADR does not modify existing production behavior. The bug fix and operational validation belong in issue #186.

## Related source and records

- `AGENTS.md` — agent-facing implementation rule
- `src/services/leagueMemberReads.ts` — established shared coordinator
- `src/services/leagueReinstatement.ts` — follow-up integration fix
- `src/services/interactionErrors.ts` and `src/services/operationalErrors.ts` — accurate phase-aware reporting
- [#156](https://github.com/diese-tech/Ratatoskr/issues/156) — established member-fetch coalescing
- [#183](https://github.com/diese-tech/Ratatoskr/issues/183) and [PR #185](https://github.com/diese-tech/Ratatoskr/pull/185) — reinstatement workflow
- [#186](https://github.com/diese-tech/Ratatoskr/issues/186) — production regression
