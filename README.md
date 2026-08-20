# Ratatoskr

Ratatoskr is the Discord operations bot for the **Yggdrasil Smite League (YSL)**.

The bot is intended to handle deterministic league administration first: formatted announcements, pins, self-service roles, staff-managed role changes, roster operations, trades, and eventually question answering grounded in league-owned documentation.

## Design principles

- **Operations first.** Ratatoskr should automate repetitive Discord and roster work without becoming a catch-all bot.
- **Deterministic permissions.** Competitive role changes should go through explicit, auditable workflows.
- **League canon is source-of-truth.** Rules, policies, terminology, and other league knowledge live under `docs/canon/` and will later feed a small retrieval layer for grounded answers.
- **No AI required for core operations.** Trades, roles, pins, announcements, and validation should remain predictable even if the future knowledge assistant is unavailable.
- **Reusable components, YSL-specific rules.** Generic Discord infrastructure can be reused elsewhere; league policy stays isolated from the bot framework.

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

## Development status

Scaffold only. Command behavior and persistent storage are intentionally not locked yet.

## Local setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add the Discord application credentials.
4. Run `npm install`.
5. Run `npm run dev`.

Do not commit `.env` or Discord tokens.
