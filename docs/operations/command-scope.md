# Command Scope

This document summarizes Ratatoskr's operational surface. The runtime command registry remains authoritative.

Run `/help` in Discord for a private, plain-English quickstart covering every shipped command.

## Scout games

- `/scout config` — admins bind `#scout-ops` and configure additional scout staff roles, timezone, five required role emoji, and optional Fill.
- `/scout create division:<division>` — authorized staff or that division's managers/captains create a setup from `#scout-ops`; Ratatoskr posts it to the selected division's managed signup channel.
- `/scout cancel division:<division>` — the same managers select and confirm cancellation from `#scout-ops`.
- Public signup posts contain information and reactions only. Durable review/cancel controls live in `#scout-ops`; published replacement and swap controls live in the division results channel. Every handler rechecks division authorization and channel scope.

See [`scout-workflow.md`](scout-workflow.md) for the complete flow.

## Planned operations

### Announcements
Staff submits formatted content and a destination channel. Ratatoskr posts the message under the bot identity so league announcements remain visually consistent.

### Pins
Authorized staff can pin or unpin a target message without receiving broad channel-management permissions.

### Roles
Support both controlled self-service roles and staff-managed role changes. Competitive roles should be changed through explicit workflows rather than broad `Manage Roles` access.

### Trades
A trade workflow should accept one or more player-to-team moves in a single transaction, validate the full trade before mutation, require an authorized initiator or approval path, then update team/roster roles and write an audit record.

Example concept:

```text
/trade
  move @user1 -> Team Two
  move @user2 -> Team One
```

The final UX should favor Discord slash commands, selects, autocomplete, and confirmation over fragile free-text parsing.

## Out of scope

- General-purpose AI chat
- Automated policy decisions not backed by canon
- Match scores or regular-season ownership inside the scout workflow
- Full league website/database ownership
- Feature parity with unrelated Discord bots
