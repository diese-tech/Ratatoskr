# Ratatoskr

Ratatoskr is the Discord operations bot for the **Yggdrasil Smite League (YSL)**.

The bot handles deterministic league administration first. Its currently shipped workflows provision the Discord server and divisions, manage season workspaces, and run division-scoped preseason scout signups through roster publication.

## Design principles

- **Operations first.** Ratatoskr should automate repetitive Discord and roster work without becoming a catch-all bot.
- **Deterministic permissions.** Competitive role changes should go through explicit, auditable workflows.
- **League canon is source-of-truth.** Rules, policies, terminology, and other league knowledge live under `docs/canon/` and will later feed a small retrieval layer for grounded answers.
- **No AI required for core operations.** Trades, roles, pins, announcements, and validation should remain predictable even if the future knowledge assistant is unavailable.
- **Reusable components, YSL-specific rules.** Generic Discord infrastructure can be reused elsewhere; league policy stays isolated from the bot framework.

## Shipped capabilities

- Idempotent base-server and division provisioning
- Division lifecycle status, archive, and guarded deletion
- Season workspace creation and lifecycle
- `/scout config`, `/scout create`, and `/scout cancel`
- Reaction-based role signups, two-team roster review, and exactly-once result publication

See [`docs/operations/scout-workflow.md`](docs/operations/scout-workflow.md) for the operator flow and permissions.

## Planned capabilities

### Initial operations
- Post staff-authored Discord-formatted announcements
- Pin and unpin messages through controlled commands
- Self-service/reaction-style role assignment where appropriate
- Staff-managed role assignment
- Roster/team role changes
- Trade workflows with validation, confirmation, and audit logging

### League knowledge / mini-RAG
- Rulebook lookup
- League canon and terminology
- Staff procedures
- Competition policies
- FAQ / rulings

The retrieval layer will only answer from approved documents in `docs/canon/` and should cite the source document/section used.

## Repository map

```text
src/
  commands/       Discord command handlers
  domain/         League concepts and deterministic business rules
  services/       Discord-facing application services
  config/         Runtime configuration
  knowledge/      Future document ingestion/retrieval layer

docs/
  architecture/   Technical and workflow decisions
  canon/          Approved YSL source-of-truth documents for retrieval
  operations/     Staff-facing bot procedures
  proposals/      Ideas not yet accepted as league canon
```

## Persistence and restart behavior

Runtime state is stored in SQLite. Production must point `DATABASE_PATH` at a persistent mounted volume. Public scout controls encode a setup identity and resolve current state from SQLite on every interaction. The private `/scout create` preview is intentionally short-lived and must be restarted if the bot restarts before the signup post is created.

## Local setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add the Discord application credentials.
4. Run `npm install`.
5. Run `npm run dev`.

Before opening a pull request, run `npm run typecheck`, `npm run typecheck:scripts`, `npm test`, `npm run build`, and `npm audit`.

Do not commit `.env` or Discord tokens.
