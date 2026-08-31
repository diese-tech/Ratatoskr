# Architecture Overview

Ratatoskr should keep Discord transport, league rules, persistence, and future knowledge retrieval separate.

```text
Discord interaction
      |
      v
Command handler
      |
      v
Application service
      |
      +--> domain validation / league rules
      +--> Discord role + message operations
      +--> persistence / audit log
      +--> future knowledge retrieval
```

## Boundaries

### `src/commands/`
Receives Discord interactions, validates command shape, and delegates. Keep league rules out of handlers.

### `src/domain/`
Pure league concepts and deterministic rules: roster membership, trade validity, permission intent, team/division relationships, and other policy that should be testable without Discord.

### `src/services/`
Coordinates Discord and domain operations. Role mutations should be performed through services so audit logging and rollback behavior can be centralized.

### `src/knowledge/`
Future ingestion/retrieval code for `docs/canon/`. This layer must never become a dependency for deterministic admin workflows.

## Role automation principle

Ratatoskr should become the normal writer for competitive Discord roles. Humans may retain emergency permissions, but routine roster changes should use bot workflows with validation and logging.

A trade should be treated as one atomic league operation: validate all participants and destinations first, then apply role changes, then write an audit record. If any required change fails, do not silently report success.

## Scout workflow boundary

Scout games are preseason evaluation sessions, not regular-season matches. They have no score and do not belong to the season lifecycle.

Each setup snapshots its division, signup channel, results channel, division role, role emoji, start time, and per-player role limit in SQLite. Discord component IDs contain the setup ID and expected roster version; handlers re-read authorization and current state before mutating. This makes simultaneous setups independent and lets durable controls survive a process restart.

SQLite transactions claim roster generation, edits, publication, replacement, and cancellation. Discord cannot join that transaction, so external writes use explicit compensation:

- failed publication deletes any partial result and restores `roster_ready`;
- a failed published-result edit rolls its versioned database replacement back when still safe;
- a cancelled setup remains canonically cancelled if its post edit fails, and its old Cancel control can retry post reconciliation;
- an ambiguous rollback tells staff to stop and reconcile instead of reporting success.

Private creation drafts and emoji-binding sessions are intentionally in memory and expire. Once a signup post exists, the workflow is durable.
