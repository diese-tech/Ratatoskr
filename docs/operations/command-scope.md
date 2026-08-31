# Command Scope

This document summarizes Ratatoskr's operational surface. The runtime command registry remains authoritative.

## Scout games

- `/scout config` — admins configure additional scout staff roles, timezone, and five role emoji.
- `/scout create` — authorized staff or the current division's captains create a setup from that division's managed scout-signups channel.
- `/scout cancel` — the same managers select and confirm cancellation for only that channel's division.
- Public signup, review, publish, replacement, and cancellation controls are tied to one persisted setup and recheck authorization when clicked.

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
