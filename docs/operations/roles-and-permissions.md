# Roles, Permissions, and Using Ratatoskr

A practical guide for league staff: which roles exist, how to assign them, how the
command surface works, and where to look next. Run `/help` in Discord any time for
the private, in-app version of this.

## Server-wide roles

These are created/repaired by `/server bootstrap apply` and assigned to members by
hand in Discord (Server Settings → Roles, or right-click a member → Roles):

| Role | Purpose |
| --- | --- |
| `Allfather`, `Aesir` | Full admin access to every Ratatoskr command (`ADMIN` policy). IDs are pinned in `.env` (`ROLE_ALLFATHER_ID`, `ROLE_AESIR_ID`) so this doesn't depend on the role's current name. |
| `Org Owner` | League ownership role, not currently wired to a Ratatoskr access policy. |
| `Franchise Representative` | Built-in Scout management access across **every** division (see `docs/operations/scout-workflow.md`). |
| `Valkyries`, `Production` | Staff roles; `Valkyries` is treated as staff for legacy channel permission checks. |
| `Captain` | **Not division-specific.** This is the server-wide flag that marks someone as captain-eligible. It does nothing by itself — see [Division Captain access](#division-captain-access-read-this-part) below. |
| `Player`, `Free Agent` | General membership roles. |

## Division roles

`/division add name:<division>` creates three roles per division (e.g. for Vanaheim):

| Role | How it's granted | What it's for |
| --- | --- | --- |
| `Vanaheim` | Assigned by hand | Marks someone as a member of that division. Required for division channel access, Scout signups, and (combined with `Captain`) division captain access. |
| `Vanaheim Manager` | Assigned by hand | Full Scout management access for that division only (create/cancel/review/publish). |
| `Vanaheim Captain` | **Automatic — do not assign by hand** | Scout management access for that division only, same as Manager. |

### Division Captain access — read this part

This is the part that isn't obvious and has bitten us before: **`<Division> Captain`
is a derived role, not one you assign.**

Ratatoskr grants it automatically to anyone who has **both**:

1. The server-wide `Captain` role, **and**
2. That division's role (e.g. `Vanaheim`)

If a member has both, Ratatoskr adds `<Division> Captain` for them. If they lose
either one, Ratatoskr removes `<Division> Captain` again. This reconciliation runs:

- every time any of a member's roles change (Discord `guildMemberUpdate`), and
- for every member in the server when that division is provisioned or repaired via
  `/division add`.

**This is why manually assigning `Vanaheim Captain` (or any `<Division> Captain`
role) directly looks like it "doesn't stick" or gets silently removed** — the next
role-change event re-checks the prerequisites, finds them not met, and strips it
back off.

**To make someone a division captain, do this instead:**

1. Give them the server-wide `Captain` role.
2. Give them the division's role (e.g. `Vanaheim`).
3. Ratatoskr adds `<Division> Captain` automatically within moments. No command is
   needed, and doing it in either order works.

To remove someone as a division captain, remove either the `Captain` role or their
division role — removing both is fine too. Do not try to remove `<Division>
Captain` directly; it will just get re-added if the two prerequisite roles are
still both present.

Use `/division status name:<division>` to confirm the `<Division> Captain` role
itself still exists and is managed by Ratatoskr — it does not show per-member
assignment; check the member's role list in Discord for that.

## Using Ratatoskr: commands

Ratatoskr uses Discord slash commands for entry points and Discord message
buttons/menus for anything that acts on something already on screen (a specific
roster, a specific setup). The full up-to-date list is always in `/help`
(ephemeral, only you can see the reply); the maintained written summary is
[`docs/operations/command-scope.md`](command-scope.md).

Quick orientation by namespace:

| Namespace | Who | Purpose |
| --- | --- | --- |
| `/server` | Admin | Bootstrap/repair the standard server roles and channels. |
| `/division` | Admin | Create/repair/status/archive/delete a division's channels and roles. |
| `/season` | Admin | Create, check, and close season workspaces. |
| `/scout` | Admin (config) / Division Manager & Captain / other staff | Configure Scout, create and cancel scouting games. |
| `/help` | Everyone with command access | Private in-app quickstart. |

Scout day-to-day usage (creating games, reviewing rosters, publishing, swaps,
replacements, cancellation) is documented in full in
[`docs/operations/scout-workflow.md`](scout-workflow.md).

## Finding more information

- **`/help`** — fastest path, always matches what's actually deployed.
- [`docs/operations/command-scope.md`](command-scope.md) — command surface summary and what's planned vs. shipped.
- [`docs/operations/scout-workflow.md`](scout-workflow.md) — full Scout operator workflow, setup, and failure recovery.
- [`docs/architecture/overview.md`](../architecture/overview.md) — how Ratatoskr is put together.
- [`docs/canon/`](../canon/) — approved league rules/policy source of truth.
- [Repo README](../../README.md) — project overview, setup, and design principles.
- Still stuck, or something looks wrong (like a role not syncing)? Check the bot's
  logs for `Captain access reconciliation failed` or similar errors, or open a
  GitHub issue.
