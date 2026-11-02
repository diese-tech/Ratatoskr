# Repository agent guidance

## Human-facing wording

Commands, help, forms, buttons, private replies, public status cards, staff alerts and staff guides must use simple, respectful plain English. Say what happened, whether changes were made when known, and what to do next. Do not display implementation terms, raw stored states or technical errors. Keep diagnostic detail in logs and use a readable reference for support. Never suggest repeating a saved action or an action that may already have posted.

Preserve explicitly approved/scripted announcements, including the approved Inhouse opt-in intro. Keep command syntax, authorization and confirmation/recovery rules intact when revising copy. For shared Scout/Inhouse controls, use wording that makes sense for both kinds of game.

## Discord member-read architecture (mandatory)

**Reuse, do not rebuild:** All complete-guild Discord member snapshots must go through the existing `readLeagueMembers` coordinator in `src/services/leagueMemberReads.ts` (normally via `DiscordLeagueGateway.getMembers`). It already handles one in-flight request per guild/Gateway session, bounded observation snapshots, invalidation, backoff from Discord's actual Gateway `retry_after`, and diagnostics. Do not introduce a second member-list cache, throttle, scheduler, or direct whole-guild `guild.members.fetch()` call. Targeted fresh `guild.members.fetch({ user, force: true })` remains appropriate for identity-specific checks.

Multi-step **read-only** staff flows must pass their already verified complete member/Sheet snapshot through the same logical lookup and initial preview, rather than making sequential whole-guild requests simply to redraw options. Minimize repeat full reads on picker/advisory interactions; a presentation cache or saved preview must **never** authorize mutation. Recheck authorization, relevant Discord/Sheet state, source history, stale fingerprints and before-values at confirmation and again in the serialized worker before writing. Never silently fall back to stale/incomplete member data for execution or declare a clean audit from it.

A Gateway throttle before enqueue/write is a **no-change, read-only deferral**: honor `retry_after`, explain the wait privately, and avoid false staff alerts claiming partial roster writes or uncertain public posts. Actual interrupted/ambiguous writes still require durable reconciliation and staff warnings. Preserve the scheduled full audit and existing job priorities.

**Canonical decision:** [ADR 0001](docs/adr/0001-shared-league-member-reads.md). Existing coordinator: [#156](https://github.com/diese-tech/Ratatoskr/issues/156). Read-only reinstatement regression and tests: [#186](https://github.com/diese-tech/Ratatoskr/issues/186).

## Agent skills

### Issue tracker and pull requests

Work items and PRDs live in this repository's GitHub Issues. External pull requests are not a triage request surface. Use the repository's standard issue information model when creating implementation-facing issues, and use the repository's pull-request evidence model when opening or updating PRs. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read root `CONTEXT.md` and relevant records under `docs/adr/` when they exist. See `docs/agents/domain.md`.
