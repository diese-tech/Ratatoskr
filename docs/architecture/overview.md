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

Each setup snapshots its division, Scout Ops control channel, signup channel, results channel, division role, optional eligibility role, five required role emoji, optional Fill emoji, start time, and per-player role limit in SQLite. Fill is a signup preference that can satisfy any standard roster role; it never becomes a roster slot. Eligibility is re-read from current Discord membership before generation, shuffle, manual seating, replacement, expansion, and publication. A roster-ready setup may atomically expand from one game to two when twenty unique eligible signups can satisfy all twenty role slots; the setup remains the ownership boundary for both games. Discord component IDs contain the setup ID and expected roster version; handlers re-read authorization, current state, and expected channel before mutating. This makes simultaneous setups independent and keeps public signup posts free of staff controls.

SQLite transactions claim roster generation, edits, publication, replacement, and cancellation. Discord cannot join that transaction, so external writes use explicit compensation:

- failed publication deletes any partial result and restores `roster_ready`; startup markers recover a result sent immediately before a crash;
- a failed published-result edit rolls its versioned database replacement or swap back when still safe;
- a cancelled setup remains canonically cancelled if its post edit fails, and startup reconciliation retries the public post update;
- an ambiguous rollback tells staff to stop and reconcile instead of reporting success.

Private creation drafts and emoji-binding sessions are intentionally in memory and expire. Startup reconciliation repairs incomplete signup posts, re-reads active reactions, recovers interrupted publishes, and restores or finalizes Scout Ops panels.
