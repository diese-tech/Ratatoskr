import type { LeagueSnapshot } from '../domain/leagueOperations.js';

const divisions = ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const;

function quoted(value: string): string {
  return `“${value || 'blank'}”`;
}

function list(values: string[]): string {
  return values.length ? values.join(', ') : 'none';
}

function playerName(snapshot: LeagueSnapshot, discordId: string): string {
  return snapshot.names.find((row) => row.discordId === discordId)?.currentLeagueName
    ?? snapshot.rosters.find((row) => row.discordId === discordId)?.player
    ?? snapshot.discordMembers.find((member) => member.discordId === discordId)?.displayName
    ?? 'An unidentified player';
}

function rosterFor(snapshot: LeagueSnapshot, discordId: string) {
  return snapshot.rosters.find((row) => row.discordId === discordId);
}

function roleName(snapshot: LeagueSnapshot, roleId: string): string {
  const team = snapshot.teams.find((entry) => entry.teamRoleId === roleId);
  if (team) return team.teamRole;
  const division = snapshot.teams.find((entry) => entry.divisionRoleId === roleId)?.division;
  if (division) return `${division} division role`;
  if (roleId === snapshot.freeAgentRoleId) return 'Free Agent role';
  return 'an unmanaged Discord role';
}

function discordTeamRoles(snapshot: LeagueSnapshot, discordId: string): string[] {
  const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
  if (!member) return [];
  return member.roleIds
    .map((roleId) => snapshot.teams.find((team) => team.teamRoleId === roleId)?.teamRole)
    .filter((name): name is string => Boolean(name));
}

function discordDivisionRoles(snapshot: LeagueSnapshot, discordId: string): string[] {
  const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
  if (!member) return [];
  return member.roleIds.flatMap((roleId) => {
    const division = snapshot.teams.find((team) => team.divisionRoleId === roleId)?.division;
    return division ? [division] : [];
  }).filter((division, index, all) => all.indexOf(division) === index);
}

function humanize(snapshot: LeagueSnapshot, issue: string): string {
  let match: RegExpMatchArray | null;

  match = issue.match(/^Managed player names for (\S+) do not match the current Discord display name\.$/);
  if (match) {
    const discordId = match[1]!;
    const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
    const roster = rosterFor(snapshot, discordId);
    const current = snapshot.names.find((entry) => entry.discordId === discordId && entry.nameStatus === 'Current Discord Name');
    return [
      roster?.team ?? current?.franchise ?? 'Unassigned player',
      `Discord name now: ${quoted(member?.displayName ?? 'missing')}`,
      `Current Rosters sheet: ${quoted(roster?.player ?? 'not rostered')}`,
      `Player Name History sheet: ${quoted(current?.currentLeagueName ?? 'missing')}`,
      'Required: update the managed roster sheets to the Discord name. Previous names stay in history.',
    ].join('\n');
  }

  match = issue.match(/^Current Rosters player name for (\S+) does not match its Current League Name\.$/);
  if (match) {
    const row = rosterFor(snapshot, match[1]!);
    const current = snapshot.names.find((entry) => entry.discordId === match![1])?.currentLeagueName ?? 'missing';
    return `${row?.team ?? 'Unknown team'} — Current Rosters: ${quoted(row?.player ?? 'missing')}; Player Name History: ${quoted(current)}. Make the names match.`;
  }

  match = issue.match(/^Discord member (\S+) has conflicting Current League Name values\.$/);
  if (match) {
    const values = snapshot.names.filter((row) => row.discordId === match![1]).map((row) => row.currentLeagueName);
    return `${playerName(snapshot, match[1]!)} has conflicting current league names (${list(values)}). Keep one current value in Player Name History.`;
  }
  match = issue.match(/^Discord member (\S+) must have exactly one current name record\.$/);
  if (match) {
    const count = snapshot.names.filter((row) => row.discordId === match![1] && row.nameStatus === 'Current Discord Name').length;
    return `${playerName(snapshot, match[1]!)} has ${count} current-name rows in Player Name History. Keep exactly one.`;
  }
  match = issue.match(/^Discord member (\S+) appears more than once in Current Rosters\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} appears more than once in Current Rosters. Keep only the active assignment.`;
  match = issue.match(/^Current Rosters member (\S+) references an inactive or unknown team role\.$/);
  if (match) {
    const row = rosterFor(snapshot, match[1]!);
    return `${playerName(snapshot, match[1]!)} — Current Rosters row ${row?.sheetRow ?? 'unknown'} points to a team Ratatoskr does not manage. Select the correct active team in League Teams.`;
  }
  match = issue.match(/^Current Rosters member (\S+) does not match configured team (.+)\.$/);
  if (match) {
    const row = rosterFor(snapshot, match[1]!);
    return `${playerName(snapshot, match[1]!)} — Current Rosters says ${row?.division ?? 'unknown division'} / ${row?.franchise ?? 'unknown franchise'} / ${row?.team ?? 'unknown team'}, but its role maps to ${match[2]}. Make that row match League Teams.`;
  }
  match = issue.match(/^Current Rosters member (\S+) has no Current League Name\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is in Current Rosters but has no current entry in Player Name History. Add one before processing transactions.`;
  match = issue.match(/^Current name record for (\S+) does not match its Current Rosters assignment\.$/);
  if (match) {
    const roster = rosterFor(snapshot, match[1]!);
    const name = snapshot.names.find((row) => row.discordId === match![1] && row.nameStatus === 'Current Discord Name');
    return `${playerName(snapshot, match[1]!)} — Player Name History says ${name?.division ?? 'unknown division'} / ${name?.franchise || 'no team'} / ${name?.leagueStatus ?? 'unknown status'}; Current Rosters says ${roster?.division ?? 'unknown division'} / ${roster?.franchise ?? 'unknown team'} / ${roster?.rosterStatus ?? 'unknown status'}. Make the assignments match.`;
  }
  match = issue.match(/^Current player (\S+) must have exactly one Current Rosters assignment\.$/);
  if (match) {
    const count = snapshot.rosters.filter((row) => row.discordId === match![1]).length;
    return `${playerName(snapshot, match[1]!)} is marked as an active player but has ${count} Current Rosters assignments. Keep exactly one active assignment.`;
  }
  match = issue.match(/^Discord member (\S+) has multiple team roles\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} has multiple team roles in Discord (${list(discordTeamRoles(snapshot, match[1]!))}). Keep only the current team.`;
  match = issue.match(/^Discord member (\S+) team role does not match Current Rosters\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} — Discord team: ${list(discordTeamRoles(snapshot, match[1]!))}; Current Rosters team: ${rosterFor(snapshot, match[1]!)?.team ?? 'none'}. Make them match.`;
  match = issue.match(/^Discord member (\S+) is rostered without its team role\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is listed on ${rosterFor(snapshot, match[1]!)?.team ?? 'a team'} but is missing that team role in Discord. Restore the role or correct Current Rosters.`;
  match = issue.match(/^Discord member (\S+) division roles do not match (Vanaheim|Alfheim|Svartalfheim)\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} — Discord division: ${list(discordDivisionRoles(snapshot, match[1]!))}; expected: ${match[2]}. Make the division role match.`;
  match = issue.match(/^Discord member (\S+) is rostered but still has the Free Agent role\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is rostered on ${rosterFor(snapshot, match[1]!)?.team ?? 'a team'} but still has the Free Agent role. Remove the Free Agent role.`;
  match = issue.match(/^Discord member (\S+) is recorded as a free agent but is missing the Free Agent role\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is listed as a free agent but is missing the Free Agent role in Discord. Restore the role or correct Player Name History.`;
  match = issue.match(/^Discord member (\S+) has the Free Agent role but is not recorded as a current free agent\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} has the Free Agent role in Discord but is not listed as a current free agent. Remove the role or correct Player Name History.`;
  match = issue.match(/^Current Rosters member (\S+) is not in the Discord member snapshot\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is in Current Rosters but is no longer in the Discord server. Confirm whether this is a departure before changing the roster.`;
  match = issue.match(/^Current free agent (\S+) must not retain a franchise assignment\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is a free agent but still has a franchise in Player Name History. Clear the franchise cell.`;
  match = issue.match(/^Current free agent (\S+) is not in the Discord member snapshot\.$/);
  if (match) return `${playerName(snapshot, match[1]!)} is listed as a free agent but is no longer in the Discord server. Mark the player inactive if the departure is confirmed.`;

  match = issue.match(/^Role (\S+) is configured as both a team role and a division role\.$/);
  if (match) return `${roleName(snapshot, match[1]!)} is used as both a team role and a division role in League Teams. Give each purpose its own Discord role.`;
  match = issue.match(/^Free Agent role \S+ is also configured as a (team|division) role\.$/);
  if (match) return `The Free Agent role is also configured as a ${match[1]} role in League Teams. Give each purpose its own Discord role.`;
  match = issue.match(/^Team role (\S+) is configured more than once\.$/);
  if (match) return `${roleName(snapshot, match[1]!)} is listed more than once as an active team role in League Teams. Keep one active mapping.`;
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) (.+) is configured as more than one active team\.$/);
  if (match) return `${match[1]} / ${match[2]} appears more than once as an active team in League Teams. Keep one active row.`;
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) is configured with more than one division role\.$/);
  if (match) return `${match[1]} has more than one division role in League Teams. Use one division role for every ${match[1]} team.`;
  match = issue.match(/^Division role (\S+) is shared by (Vanaheim|Alfheim|Svartalfheim) and (Vanaheim|Alfheim|Svartalfheim)\.$/);
  if (match) return `${roleName(snapshot, match[1]!)} is shared by ${match[2]} and ${match[3]}. Give each division its own role.`;

  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) (.+) has no managed public roster block\.$/);
  if (match) return `${match[1]} / ${match[2]} has no team section on the public roster sheet. Add the section before processing transactions.`;
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) (.+) has duplicate current player names\.$/);
  if (match) return `${match[1]} / ${match[2]} has duplicate player names in the managed roster data. Correct the duplicate before processing transactions.`;
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) (.+) public roster does not match Current Rosters\.$/);
  if (match) {
    const team = snapshot.teams.find((entry) => entry.division === match![1] && entry.franchise === match![2]);
    const expected = snapshot.rosters.filter((row) => row.teamRoleId === team?.teamRoleId).map((row) => row.player);
    const actual = snapshot.publicRosters[match[1] as typeof divisions[number]]?.teams[match[2]!] ?? [];
    return `${match[1]} / ${match[2]} — Current Rosters: ${list(expected)}; public roster: ${list(actual)}. Make the player lists match.`;
  }
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) free agents have duplicate current player names\.$/);
  if (match) return `${match[1]} free agents contain duplicate current player names. Keep one current entry per player.`;
  match = issue.match(/^(Vanaheim|Alfheim|Svartalfheim) public free-agent list does not match Player Name History\.$/);
  if (match) {
    const division = match[1] as typeof divisions[number];
    const expected = snapshot.names.filter((row) => row.nameStatus === 'Current Discord Name' && row.division === division && row.leagueStatus === 'Free Agent').map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    return `${division} free agents — Player Name History: ${list(expected)}; public roster: ${list(actual)}. Make the player lists match.`;
  }

  return 'Ratatoskr found a roster rule mismatch that it could not explain safely. Ask a bot operator to translate the latest audit before changing anything.';
}

export function humanizeLeagueAuditIssues(snapshot: LeagueSnapshot, issues: string[]): string[] {
  return [...new Set(issues.map((issue) => humanize(snapshot, issue)))];
}
