# ADR 0002: Layered Niflheim membership

- **Status:** Accepted
- **Recorded:** 2026-11-04
- **Scope:** How Rat models, audits and repairs Niflheim team memberships
- **Tracker:** [#195](https://github.com/diese-tech/Ratatoskr/issues/195); implemented in [#198](https://github.com/diese-tech/Ratatoskr/issues/198)

## Context

YSL added Niflheim, a temporary fourth division for players who did not land on a Svartalfheim team. A Niflheim player is **also** a Svartalfheim free agent or a rostered Svartalfheim player. For example, Qronch plays for Svartalfheim Little Monsters and captains Niflheim Something Spicy, which is intended.

Before this decision, Rat assumed one Current Rosters row, one primary status and one team role per Discord ID. Every Niflheim player would have failed the roster audit, and "Fix Discord roles" would have stripped their Niflheim roles. [#178](https://github.com/diese-tech/Ratatoskr/issues/178) had added `ROLE_NIFLHEIM_FREE_AGENT_ID`, a narrow setting that only hid "untracked free agent" findings.

## Decision

1. **The Svartalfheim record stays primary.** The player's Player Name History `Current Discord Name` row keeps division `Svartalfheim`, status `Free Agent`, `Player` or `Captain`, and the Svartalfheim franchise or blank. Name History has no Niflheim status.
2. **Niflheim is a second Current Rosters row.** It has division `Niflheim`, the Niflheim franchise, the `<Franchise> ND` team role, and status `Player` or `Captain`. No new tabs, columns or tables are added.
3. **Allowed combinations per Discord ID:**
   - at most one non-Niflheim ("primary") roster row;
   - at most one Niflheim row;
   - a Niflheim row only when the primary record is a current Svartalfheim `Free Agent`, `Player` or `Captain`. A Vanaheim, Alfheim, Inactive, Suspended or missing primary record with a Niflheim row is a finding.
4. **Expected managed roles:**

   | Svartalfheim record | Niflheim row | Expected roles |
   |---|---|---|
   | Free agent | yes | `Free Agent` + `Svartalfheim` + `Niflheim` + `<Team> ND` |
   | Rostered | yes | `<Team> SD` + `Svartalfheim` + `Niflheim` + `<Team> ND` (no `Free Agent`) |
   | Either | no | No `Niflheim` and no ND role |

   The primary checks (one team role, one division role, Free Agent) ignore Niflheim roles. The Niflheim team and division roles are checked separately: they are held exactly when the Niflheim row exists.
5. **Public rosters.** Niflheim team blocks list Niflheim rows. The Svartalfheim free-agent list still includes Svartalfheim free agents who are also on a Niflheim team. Niflheim has no free-agent list.
6. **Code shape.** `LEAGUE_DIVISION_METADATA[d].layeredOn` marks a layered division. `primaryRoster` and `layeredRoster` in `src/domain/leagueOperations.ts` make every lookup explicit. Primary is the default for all existing behavior. A layered player's Svartalfheim drop, pickup or trade leaves the Niflheim row alone. A rename updates both rows and the Niflheim public block, since a player has one league name. `LeagueRoleState.layered` carries the Niflheim roles through transaction checks and "Fix Discord roles". It is absent while no Niflheim team is active, so the state is unchanged for everyone else.
7. **Retire #178.** `ROLE_NIFLHEIM_FREE_AGENT_ID` no longer affects the audit, the reconciliation or the snapshot. If it is still set, Rat logs one warning and ignores it. A human removes it from Railway after deploy.

## Consequences

- Layered players pass a clean audit. Each violation gets its own plain-English finding. Role findings route to "Set Discord roles from roster sheets", which adds or removes only the incorrect managed roles and never removes a valid Niflheim role.
- Behavior for players without a Niflheim row is unchanged. A golden test from before #197 pins it.
- Niflheim roster transactions are left to [#200](https://github.com/diese-tech/Ratatoskr/issues/200): trades and pickups within Niflheim, a Niflheim drop, and departures that end both memberships. Until then, account replacement refuses a layered player rather than guessing. A Svartalfheim departure or self-drop ends only the Svartalfheim membership, and the audit then reports the leftover Niflheim row for staff to remove.
- Niflheim is temporary. Deactivating its League Teams rows stops Rat reading it, and removing `Niflheim` from `LEAGUE_DIVISIONS` is the code cleanup.
- Pull-up subs are not modeled.
