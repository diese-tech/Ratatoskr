# Repository agent guidance

## Accepted backup risk and release approval

Follow [ADR 0003](docs/adr/0003-backup-policy-and-accepted-operational-risk.md): the owner accepts operating without a verified current production recovery backup. Managed cloud backups are deferred; missing backups alone do not block source review, approved release or read-only acceptance. Do not repeatedly reopen this decision or add backup infrastructure/schedules without authorization. Missing/corrupt production storage, unsafe migrations and weakened durable/reconciliation safeguards remain defects. Historical copies are not presumed current.

The owner uses [merge-to-deploy](docs/operations/production-release.md): Railway native autodeploy stays enabled for main. Require full local validation, final-head Windows/Ubuntu CI, both CodeQL analyses and independent source/Codex review with no unresolved blocking findings before an authorized merge. The merge intentionally triggers normal Railway deployment; verify the exact deployed revision and health afterward. Do not disable/disconnect autodeploy, add a manual release pipeline, alter production settings or manually deploy/restart without separate authorization. Read-only acceptance never authorizes roster transactions or repair.

## Human-facing wording

Commands, help, forms, buttons, private replies, public status cards, staff alerts and staff guides must use simple, respectful plain English. Say what happened, whether changes were made when known, and what to do next. Do not display implementation terms, raw stored states or technical errors. Keep diagnostic detail in logs and use a readable reference for support. Never suggest repeating a saved action or an action that may already have posted.

Preserve explicitly approved/scripted announcements, including the approved Inhouse opt-in intro. Keep command syntax, authorization and confirmation/recovery rules intact when revising copy. For shared Scout/Inhouse controls, use wording that makes sense for both kinds of game.

## Discord member-read architecture (mandatory)

**Reuse, do not rebuild:** All complete-guild Discord member snapshots must go through the existing `readLeagueMembers` coordinator in `src/services/leagueMemberReads.ts` (normally via `DiscordLeagueGateway.getMembers`). It already handles one in-flight request per guild/Gateway session, bounded observation snapshots, invalidation, backoff from Discord's actual Gateway `retry_after`, and diagnostics. Do not introduce a second member-list cache, throttle, scheduler, or direct whole-guild `guild.members.fetch()` call. Targeted fresh `guild.members.fetch({ user, force: true })` remains appropriate for identity-specific checks. **Only exception: manually approved maintenance scripts (owner-approved, #196 and #199).** A script in `scripts/` that never runs inside the bot may list members once with paginated Discord REST `GET` requests (no Gateway login). It may also write, when the owner approves the run, whether the owner runs it or asks an agent to. These scripts exist so league data can be gathered or corrected without waiting for a bot release, while keeping that work off the bot's own member-read and job paths. Conditions:
- **Approved runs only:** each run that writes is approved by the owner for that run.
- **Preview first:** a write needs a dry run whose plan staff reviewed. It re-reads its sources immediately before writing and stops without writing if anything changed.
- **No impact on the bot:** respect Discord and Google rate limits (REST `retry_after`, one member listing per run), and leave nothing that stops the bot from starting or running normally once the script finishes.
- **Report clearly:** say exactly what was written. Never suggest replaying a write that may have partly happened.

Script code must not be imported by bot runtime modules; a test enforces this for `src/services/divisionInspection.ts` and `src/services/divisionImport.ts`. Any new script using this exception must state it in its header. Bot features, commands and jobs never use this path. See ADR 0001.

Multi-step **read-only** staff flows must pass their already verified complete member/Sheet snapshot through the same logical lookup and initial preview, rather than making sequential whole-guild requests simply to redraw options. For later picker/advisory redraws, use the coordinator's bounded read-only observation snapshot (`getMembers({ observation: true })`) instead of a fresh whole-guild request; an observation snapshot, presentation cache or saved preview must **never** authorize mutation. At confirmation, freshly authorize the actor and validate the reviewed intent, approval identity, workflow validity and required acknowledgements. A second complete Discord/Sheets read at confirmation is not universally required: the serialized worker must independently recheck authorization and fresh relevant Discord/Sheet state, source history, fingerprints and before-values before mutation. Retain reinstatement’s stronger confirmation-time validation. Freshly reauthorize the approving actor at the guarded pre-write boundary after substantive asynchronous validation and before the first external write. Never silently fall back to stale/incomplete member data for execution or declare a clean audit from it.

Unconfirmed previews may be temporary or persisted; existing transaction and reinstatement preview persistence remains unchanged. Confirmable previews bind guild, actor, exact intent, fingerprint and approval identity. Accepted approvals must be durable through canonical job creation or aliasing before external mutation is eligible; the durable commit, not the Discord reply, establishes acceptance. Duplicate accepted approvals retain their job. Expiry, restart, refresh, cancellation and new sessions cannot renew or erase them. Temporary previews fail closed after session loss, and neither preview type bypasses fresh execution validation. A lost acknowledgement never permits automatic resubmission. See the [durable-acceptance amendment](docs/adr/0001-authoritative-league-roster-mutations.md#amendment-preview-lifetime-and-durable-acceptance-2026-11-13).

A Gateway throttle before enqueue/write is a **no-change, read-only deferral**: honor `retry_after`, explain the wait privately, and avoid false staff alerts claiming partial roster writes or uncertain public posts. Actual interrupted/ambiguous writes still require durable reconciliation and staff warnings. Preserve the scheduled full audit and existing job priorities.

**Canonical decision:** [ADR 0001](docs/adr/0001-shared-league-member-reads.md). Existing coordinator: [#156](https://github.com/diese-tech/Ratatoskr/issues/156). Read-only reinstatement regression and tests: [#186](https://github.com/diese-tech/Ratatoskr/issues/186), fixed in [PR #188](https://github.com/diese-tech/Ratatoskr/pull/188).

## Agent skills

### Issue tracker and pull requests

Work items and PRDs live in this repository's GitHub Issues. External pull requests are not a triage request surface. Use the repository's standard issue information model when creating implementation-facing issues, and use the repository's pull-request evidence model when opening or updating PRs. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read root `CONTEXT.md` and relevant records under `docs/adr/` when they exist. See `docs/agents/domain.md`.
