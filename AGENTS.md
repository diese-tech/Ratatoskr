# Repository agent guidance

## Human-facing wording

Commands, help, forms, buttons, private replies, public status cards, staff alerts and staff guides must use simple, respectful plain English. Say what happened, whether changes were made when known, and what to do next. Do not display implementation terms, raw stored states or technical errors. Keep diagnostic detail in logs and use a readable reference for support. Never suggest repeating a saved action or an action that may already have posted.

Preserve explicitly approved/scripted announcements, including the approved Inhouse opt-in intro. Keep command syntax, authorization and confirmation/recovery rules intact when revising copy. For shared Scout/Inhouse controls, use wording that makes sense for both kinds of game.

## Agent skills

### Issue tracker and pull requests

Work items and PRDs live in this repository's GitHub Issues. External pull requests are not a triage request surface. Use the repository's standard issue information model when creating implementation-facing issues, and use the repository's pull-request evidence model when opening or updating PRs. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read root `CONTEXT.md` and relevant records under `docs/adr/` when they exist. See `docs/agents/domain.md`.
