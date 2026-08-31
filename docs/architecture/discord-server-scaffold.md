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
2. `Aesir` — administrators
3. `Valkyries` — moderators / league staff

### Functional roles

- `Production`
- `Org Owner`
- `Captain`
- `Player`
- `Free Agent`

### Canonical division names

Highest to lowest:

1. `Vanaheim`
2. `Alfheim`
3. `Jotunheim`
4. `Muspelheim`
5. `Svartalfheim`

Named after realms from Norse mythology, matching the server's Yggdrasil theme. All five are defined templates available as `/division` choices. The base bootstrap does **not** create them automatically; each division is provisioned only when YSL activates it via `/division add`.

## Division provisioning

Ratatoskr exposes a reusable division provisioner used by runtime commands. `/division add name:<division>` creates or repairs exactly one division.

A provisioned division contains:

```text
@<Division>
@<Division> Captain Access   (hidden utility role)

<Division>
├─ #<division>-captain-chat
├─ #<division>-announcements
├─ #<division>-general
├─ #<division>-tier-list
├─ #<division>-scheduling
├─ #<division>-match-reports
├─ #<division>-scout-signups
├─ #<division>-scout-results
└─ 🔊 <Division> Lobby
```

Every text channel is division-prefixed, not just announcements -- with several divisions all sharing generic channel names like "general", an unprefixed `#general` is ambiguous in Discord's mention autocomplete and channel list without checking which category it's under. The division role grants access to the category. `#<division>-captain-chat` is the only tighter-permission exception and is visible to the division-specific captain utility role plus staff.

Discord cannot express `Division AND Captain` directly, so Ratatoskr automatically reconciles utility access roles:

- member has `Captain` + `Vanaheim` → ensure `Vanaheim Captain Access`
- member loses either role → remove `Vanaheim Captain Access`

Humans should not manually manage these utility roles.

Existing unprefixed division text channels—including `#captain-chat`, `#general`, `#tier-list`, `#scheduling`, `#match-reports`, `#scout-signups`, and `#scout-results`—are adopted by Discord ID only when exactly one matching channel of the expected type exists inside the selected division category. Provisioning then renames them to the division-prefixed convention; history and message links remain attached to the same channel IDs. Ambiguous matches fail closed, and extra channels such as a second lobby remain unmanaged and untouched.

### Division commands

- `/division add` — idempotently create or repair a selected division
- `/division status` — report missing role/category/channel pieces
- `/division archive` — hide the category and all child channels from normal division access while preserving history
- `/division delete` — permanently remove an already archived, fully managed division

Archive and delete refuse while that division has an open or roster-ready scout setup. Published and cancelled setups preserve history but do not block the lifecycle.

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
- `Admin` — Valkyries / Aesir / Allfather

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
