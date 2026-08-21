# YSL Discord Server Scaffold

This is the working mock structure for the Yggdrasil Smite League Discord. It is intentionally additive and safe to iterate on before touching the live server.

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

The current role list is also intentionally light (`Admin` plus integrations such as Dyno).

The bootstrapper does **not** delete or rename these existing items. Migration/cleanup should happen only after the mock structure is approved.

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

### Division roles

Highest to lowest:

1. `Crown`
2. `Canopy`
3. `Ironbranch`
4. `Heartwood`
5. `Deep Root`

Division roles grant access to the normal channels for that division.

### Utility access roles

Discord permissions are additive and cannot express a true `Division AND Captain` requirement. For captain-only channels, Ratatoskr therefore creates non-hoisted utility roles:

- `Crown Captain Access`
- `Canopy Captain Access`
- `Ironbranch Captain Access`
- `Heartwood Captain Access`
- `Deep Root Captain Access`

These are permission implementation details, not identity/status roles. Ratatoskr can maintain them automatically based on a member's `Captain` + division state.

Org roles are not included in the bootstrap because organization names are not known yet and org roles are primarily cosmetic/identity roles. Ratatoskr can add them later from league configuration.

## Mock category layout

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

Crown
├─ #crown-announcements
├─ #crown-general
├─ #schedule-results
├─ #captains
└─ 🔊 Crown Lobby

Canopy
├─ #canopy-announcements
├─ #canopy-general
├─ #schedule-results
├─ #captains
└─ 🔊 Canopy Lobby

Ironbranch
├─ #ironbranch-announcements
├─ #ironbranch-general
├─ #schedule-results
├─ #captains
└─ 🔊 Ironbranch Lobby

Heartwood
├─ #heartwood-announcements
├─ #heartwood-general
├─ #schedule-results
├─ #captains
└─ 🔊 Heartwood Lobby

Deep Root
├─ #deep-root-announcements
├─ #deep-root-general
├─ #schedule-results
├─ #captains
└─ 🔊 Deep Root Lobby

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

## Access model

Public categories remain visible to `@everyone`.

Restricted categories use default-deny permissions:

- `League Players` — player/staff layer
- each division — corresponding division role + staff
- `Org Owners` — Org Owner + admin leadership
- `Production` — Production + admin leadership
- `Admin` — Valkyries / Æsir / Allfather

`#captains` inside each division is a deliberate tighter-permission exception and uses the division-specific captain utility role.

## Bootstrap behavior

The bootstrap script lives at `scripts/bootstrap-guild.ts`.

Safe preview:

```bash
npm run guild:plan
```

Apply changes:

```bash
npm run guild:apply
```

The script is deliberately conservative:

- dry-run is the default
- existing matching roles/categories/channels are reused
- existing unmatched server content is preserved
- nothing is deleted
- nothing is renamed
- no migration of the current `Admin` role is attempted automatically

The mock should be reviewed before `guild:apply` is ever used against the live YSL guild.

## Branding context

The regular-season divisions represent climbing Yggdrasil. Qualified teams then earn their place in **Valhalla** for quarterfinals and semifinals, with **Ascension** reserved for the Grand Finals concept.

Working phrase: **Climb Yggdrasil. Earn Valhalla. Ascend.**
