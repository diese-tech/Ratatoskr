# YSL Discord Server Scaffold

This is the working scaffold for the Yggdrasil Smite League Discord. The base bootstrap is intentionally additive and safe to iterate on before touching the live server.

## Current live-server baseline

The initial server currently contains a minimal structure:

- `Welcome`
  - `#welcome`
- `Text Channels`
  - `#general`
- `Voice Channels`
  - `gen`
- `Admin stuff`
  - `#meeting-of-the-minds`
  - `General` voice

The bootstrapper does **not** delete or rename unmatched existing content. Restricted matching categories/channels are permission-reconciled before reuse.

## Working role model

### Themed organizational roles

1. `Allfather` — league owner / highest authority
2. `Æsir` — administrators
3. `Valkyries` — moderators / league staff

### Functional roles

- `Production`
- `Org Owner`
- `Captain`
- `Player`
- `Free Agent`

### Canonical division names

Highest to lowest:

1. `Crown`
2. `Canopy`
3. `Ironbranch`
4. `Heartwood`
5. `Deep Root`

The base bootstrap does **not** create all five divisions. Divisions are provisioned only when YSL activates them.

## Division provisioning

Ratatoskr exposes a reusable division provisioner used by runtime commands. `/division add name:<division>` creates or repairs exactly one division.

A provisioned division contains:

```text
@<Division>
@<Division> Captain Access   (hidden utility role)

<Division>
├─ #<division>-announcements
├─ #general
├─ #scheduling
├─ #match-reports
├─ #tier-list
├─ #captain-chat
└─ 🔊 <Division> Lobby
```

The division role grants access to the category. `#captain-chat` is the only tighter-permission exception and is visible to the division-specific captain utility role plus staff.

Discord cannot express `Division AND Captain` directly, so Ratatoskr automatically reconciles utility access roles:

- member has `Captain` + `Crown` → ensure `Crown Captain Access`
- member loses either role → remove `Crown Captain Access`

Humans should not manually manage these utility roles.

### Division commands

- `/division add` — idempotently create or repair a selected division
- `/division status` — report missing role/category/channel pieces
- `/division archive` — hide the category and all child channels from normal division access while preserving history

Division commands are gated by the ADMIN policy in `src/services/authorization.ts`: only members holding the role configured as `ROLE_ALLFATHER_ID` or `ROLE_AESIR_ID` may manage divisions. This is a runtime role-ID check, not Discord's native Administrator permission -- holding Administrator alone does not grant access.

## Base category layout

```text
Welcome
├─ #welcome
├─ #rules
└─ #announcements

Community
├─ #general
├─ #smite-chat
├─ #lfg
└─ 🔊 General

League Players
├─ #player-lounge
├─ #free-agency
└─ #league-resources

Org Owners
├─ #org-owner-lounge
├─ #org-admin-discussion
└─ 🔊 Org Owner Meeting

Production
├─ #production-chat
├─ #broadcast-planning
└─ 🔊 Production Room

Admin
├─ #meeting-of-the-minds
├─ #staff-ops
├─ #audit-log
└─ 🔊 Staff Room
```

`Free Agent` is included in the League Players access set so free agents can reach `#free-agency`.

## Access model

Public categories remain visible to `@everyone`.

Restricted categories use default-deny permissions:

- `League Players` — Player / Captain / Free Agent / Org Owner / staff
- each provisioned division — matching division role + staff
- `Org Owners` — Org Owner + admin leadership
- `Production` — Production + admin leadership
- `Admin` — Valkyries / Æsir / Allfather

## Bootstrap behavior

The base bootstrap lives at `scripts/bootstrap-guild.ts`.

Safe preview:

```bash
npm run guild:plan
```

Apply base changes:

```bash
npm run guild:apply
```

Safety rules:

- dry-run is the default
- matching restricted categories/channels have configured permissions reconciled before reuse
- unmatched server content is preserved
- nothing is deleted
- nothing is renamed
- divisions are activated separately through Ratatoskr
- no migration of the current `Admin` role is attempted automatically

## Branding context

The regular-season divisions represent climbing Yggdrasil. Qualified teams earn their place in **Valhalla** for quarterfinals and semifinals, with **Ascension** reserved for the Grand Finals concept.

Working phrase: **Climb Yggdrasil. Earn Valhalla. Ascend.**
