# Command Scope

This document captures the initial operational surface for Ratatoskr. Exact command syntax is intentionally not final.

## MVP candidates

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

## Out of scope for initial scaffold

- General-purpose AI chat
- Automated policy decisions not backed by canon
- Matchmaking systems
- Full league website/database ownership
- Feature parity with unrelated Discord bots
