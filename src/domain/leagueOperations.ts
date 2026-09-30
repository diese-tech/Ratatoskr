export type LeagueDivision = 'Vanaheim' | 'Alfheim' | 'Svartalfheim';

export type LeagueTeam = {
  teamKey: string;
  franchise: string;
  division: LeagueDivision;
  teamRoleId: string;
  teamRole: string;
  divisionRoleId: string;
  active: boolean;
};

export type LeagueRosterRow = {
  sheetRow: number;
  division: LeagueDivision;
  franchise: string;
  teamRoleId: string;
  team: string;
  discordId: string;
  player: string;
  rosterStatus: 'Captain' | 'Player';
};

export type LeagueNameRow = {
  sheetRow: number;
  discordId: string;
  currentLeagueName: string;
  knownName: string;
  nameStatus: string;
  division: LeagueDivision;
  franchise: string;
  leagueStatus: 'Captain' | 'Player' | 'Free Agent' | string;
};

export type DiscordLeagueMember = {
  discordId: string;
  displayName: string;
  roleIds: string[];
};

export type PublicDivisionRoster = {
  teams: Record<string, string[]>;
  freeAgents: string[];
};

export type LeagueSnapshot = {
  teams: LeagueTeam[];
  rosters: LeagueRosterRow[];
  names: LeagueNameRow[];
  discordMembers: DiscordLeagueMember[];
  publicRosters: Partial<Record<LeagueDivision, PublicDivisionRoster>>;
  freeAgentRoleId: string;
};

export type PublicRosterChange = {
  division: LeagueDivision;
  area: 'team' | 'free-agent';
  group: string;
  from: string;
  to: string;
};

export type DiscordRoleChange = { discordId: string; remove: string[]; add: string[] };

export type LeagueMutationPlan = {
  kind: 'trade' | 'drop' | 'pickup' | 'rename';
  rosters: LeagueRosterRow[];
  nameUpdates: LeagueNameRow[];
  nameHistoryAppend?: Omit<LeagueNameRow, 'sheetRow'>;
  publicChanges: PublicRosterChange[];
  discordRoleChanges: DiscordRoleChange[];
  teams: LeagueTeam[];
  players: string[];
  playerIds: string[];
};

function sorted(values: Iterable<string>): string[] {
  return [...values].map((value) => value.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function sameNames(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalNames(snapshot: LeagueSnapshot): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of snapshot.names) {
    const existing = result.get(row.discordId);
    if (existing && existing !== row.currentLeagueName) {
      throw new Error(`Discord member ${row.discordId} has conflicting Current League Name values.`);
    }
    result.set(row.discordId, row.currentLeagueName);
  }
  return result;
}

export function auditLeagueRoster(snapshot: LeagueSnapshot): string[] {
  const issues: string[] = [];
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const teamsByRole = new Map<string, LeagueTeam>();
  for (const team of activeTeams) {
    if (teamsByRole.has(team.teamRoleId)) issues.push(`Team role ${team.teamRoleId} is configured more than once.`);
    teamsByRole.set(team.teamRoleId, team);
  }

  let names: Map<string, string>;
  try { names = canonicalNames(snapshot); }
  catch (error) { issues.push(error instanceof Error ? error.message : String(error)); names = new Map(); }

  const rosterById = new Map<string, LeagueRosterRow>();
  const currentNameRows = new Map<string, LeagueNameRow[]>();
  for (const row of snapshot.names) {
    if (row.nameStatus !== 'Current Discord Name') continue;
    const rows = currentNameRows.get(row.discordId) ?? [];
    rows.push(row);
    currentNameRows.set(row.discordId, rows);
  }
  for (const row of snapshot.rosters) {
    if (rosterById.has(row.discordId)) issues.push(`Discord member ${row.discordId} appears more than once in Current Rosters.`);
    rosterById.set(row.discordId, row);
    const team = teamsByRole.get(row.teamRoleId);
    if (!team) issues.push(`Current Rosters member ${row.discordId} references an inactive or unknown team role.`);
    else if (row.division !== team.division || row.franchise !== team.franchise || row.team !== team.teamRole) {
      issues.push(`Current Rosters member ${row.discordId} does not match configured team ${team.teamRole}.`);
    }
    if (!names.has(row.discordId)) issues.push(`Current Rosters member ${row.discordId} has no Current League Name.`);
    if ((currentNameRows.get(row.discordId)?.length ?? 0) !== 1) {
      issues.push(`Current Rosters member ${row.discordId} must have exactly one current name record.`);
    }
  }

  const memberById = new Map(snapshot.discordMembers.map((member) => [member.discordId, member]));
  for (const member of snapshot.discordMembers) {
    const assignedTeamRoles = member.roleIds.filter((roleId) => teamsByRole.has(roleId));
    const roster = rosterById.get(member.discordId);
    if (assignedTeamRoles.length > 1) issues.push(`Discord member ${member.discordId} has multiple team roles.`);
    if (assignedTeamRoles.length === 1 && roster?.teamRoleId !== assignedTeamRoles[0]) {
      issues.push(`Discord member ${member.discordId} team role does not match Current Rosters.`);
    }
    if (assignedTeamRoles.length === 0 && roster) issues.push(`Discord member ${member.discordId} is rostered without its team role.`);
    if (roster) {
      const team = teamsByRole.get(roster.teamRoleId);
      if (team && !member.roleIds.includes(team.divisionRoleId)) {
        issues.push(`Discord member ${member.discordId} is missing the ${team.division} division role.`);
      }
      if (member.roleIds.includes(snapshot.freeAgentRoleId)) {
        issues.push(`Discord member ${member.discordId} is rostered but still has the Free Agent role.`);
      }
    } else {
      const currentName = currentNameRows.get(member.discordId);
      const recordedFreeAgent = currentName?.length === 1 && currentName[0]!.leagueStatus === 'Free Agent';
      if (recordedFreeAgent && !member.roleIds.includes(snapshot.freeAgentRoleId)) {
        issues.push(`Discord member ${member.discordId} is recorded as a free agent but is missing the Free Agent role.`);
      }
      if (!recordedFreeAgent && member.roleIds.includes(snapshot.freeAgentRoleId)) {
        issues.push(`Discord member ${member.discordId} has the Free Agent role but is not recorded as a current free agent.`);
      }
    }
  }
  for (const row of snapshot.rosters) {
    if (!memberById.has(row.discordId)) issues.push(`Current Rosters member ${row.discordId} is not in the Discord member snapshot.`);
  }
  for (const rows of currentNameRows.values()) {
    if (rows.length !== 1 || rows[0]!.leagueStatus !== 'Free Agent') continue;
    const row = rows[0]!;
    const member = memberById.get(row.discordId);
    if (!member) {
      issues.push(`Current free agent ${row.discordId} is not in the Discord member snapshot.`);
      continue;
    }
    const divisionRoleId = activeTeams.find((team) => team.division === row.division)?.divisionRoleId;
    if (!divisionRoleId || !member.roleIds.includes(divisionRoleId)) {
      issues.push(`Discord member ${row.discordId} is missing the ${row.division} division role.`);
    }
  }

  for (const team of activeTeams) {
    const expected = snapshot.rosters
      .filter((row) => row.teamRoleId === team.teamRoleId)
      .map((row) => names.get(row.discordId) ?? '');
    const actual = snapshot.publicRosters[team.division]?.teams[team.franchise] ?? [];
    if (!sameNames(expected, actual)) issues.push(`${team.division} ${team.franchise} public roster does not match Current Rosters.`);
  }
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const) {
    const expected = snapshot.names
      .filter((row) => row.nameStatus === 'Current Discord Name' && row.division === division && row.leagueStatus === 'Free Agent')
      .map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    if (!sameNames(expected, actual)) issues.push(`${division} public free-agent list does not match Player Name History.`);
  }
  return issues;
}

function requireRoster(snapshot: LeagueSnapshot, discordId: string): LeagueRosterRow {
  const rows = snapshot.rosters.filter((row) => row.discordId === discordId);
  if (rows.length !== 1) throw new Error(rows.length ? `${discordId} has multiple roster assignments.` : `${discordId} is not rostered.`);
  return rows[0]!;
}

function requireTeam(snapshot: LeagueSnapshot, roleId: string): LeagueTeam {
  const team = snapshot.teams.find((candidate) => candidate.active && candidate.teamRoleId === roleId);
  if (!team) throw new Error('The selected role is not an active YSL team role.');
  return team;
}

function currentNameRow(snapshot: LeagueSnapshot, discordId: string): LeagueNameRow {
  const rows = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
  if (rows.length !== 1) throw new Error(`${discordId} must have exactly one current name record.`);
  return rows[0]!;
}

function replaceRosterTeam(row: LeagueRosterRow, team: LeagueTeam): LeagueRosterRow {
  return { ...row, division: team.division, franchise: team.franchise, teamRoleId: team.teamRoleId, team: team.teamRole };
}

export function buildTradePlan(snapshot: LeagueSnapshot, firstId: string, secondId: string): LeagueMutationPlan {
  if (firstId === secondId) throw new Error('A trade requires two different players.');
  const first = requireRoster(snapshot, firstId);
  const second = requireRoster(snapshot, secondId);
  const firstTeam = requireTeam(snapshot, first.teamRoleId);
  const secondTeam = requireTeam(snapshot, second.teamRoleId);
  if (firstTeam.division !== secondTeam.division) throw new Error('Cross-division trades are not supported.');
  if (firstTeam.teamRoleId === secondTeam.teamRoleId) throw new Error('Both players are already on the same team.');
  const names = canonicalNames(snapshot);
  const firstName = names.get(firstId)!;
  const secondName = names.get(secondId)!;
  return {
    kind: 'trade',
    rosters: snapshot.rosters.map((row) => row.discordId === firstId ? replaceRosterTeam(row, secondTeam) : row.discordId === secondId ? replaceRosterTeam(row, firstTeam) : { ...row }),
    nameUpdates: snapshot.names.map((row) => row.discordId === firstId && row.nameStatus === 'Current Discord Name'
      ? { ...row, franchise: secondTeam.franchise, division: secondTeam.division }
      : row.discordId === secondId && row.nameStatus === 'Current Discord Name'
        ? { ...row, franchise: firstTeam.franchise, division: firstTeam.division }
        : { ...row }),
    publicChanges: [
      { division: firstTeam.division, area: 'team', group: firstTeam.franchise, from: firstName, to: secondName },
      { division: secondTeam.division, area: 'team', group: secondTeam.franchise, from: secondName, to: firstName },
    ],
    discordRoleChanges: [
      { discordId: firstId, remove: [firstTeam.teamRoleId], add: [secondTeam.teamRoleId] },
      { discordId: secondId, remove: [secondTeam.teamRoleId], add: [firstTeam.teamRoleId] },
    ],
    teams: [firstTeam, secondTeam],
    players: [firstName, secondName],
    playerIds: [firstId, secondId],
  };
}

export function buildDropPlan(snapshot: LeagueSnapshot, discordId: string): LeagueMutationPlan {
  const roster = requireRoster(snapshot, discordId);
  const team = requireTeam(snapshot, roster.teamRoleId);
  const currentName = currentNameRow(snapshot, discordId);
  return {
    kind: 'drop',
    rosters: snapshot.rosters.filter((row) => row.discordId !== discordId).map((row) => ({ ...row })),
    nameUpdates: snapshot.names.map((row) => row.sheetRow === currentName.sheetRow
      ? { ...row, franchise: '', leagueStatus: 'Free Agent' }
      : { ...row }),
    publicChanges: [
      { division: team.division, area: 'team', group: team.franchise, from: currentName.currentLeagueName, to: '' },
      { division: team.division, area: 'free-agent', group: 'Free Agents', from: '', to: currentName.currentLeagueName },
    ],
    discordRoleChanges: [{ discordId, remove: [team.teamRoleId], add: [snapshot.freeAgentRoleId] }],
    teams: [team],
    players: [currentName.currentLeagueName],
    playerIds: [discordId],
  };
}

export function buildPickupPlan(snapshot: LeagueSnapshot, discordId: string, teamRoleId: string): LeagueMutationPlan {
  if (snapshot.rosters.some((row) => row.discordId === discordId)) throw new Error('The selected player is not a free agent.');
  const team = requireTeam(snapshot, teamRoleId);
  const currentName = currentNameRow(snapshot, discordId);
  if (currentName.leagueStatus !== 'Free Agent') throw new Error('The selected player is not a free agent.');
  if (currentName.division !== team.division) throw new Error('Cross-division pickups are not supported.');
  const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
  if (!member?.roleIds.includes(snapshot.freeAgentRoleId)) throw new Error('The selected player does not have the Free Agent role.');
  const nextRow = Math.max(5, ...snapshot.rosters.map((row) => row.sheetRow)) + 1;
  return {
    kind: 'pickup',
    rosters: [...snapshot.rosters.map((row) => ({ ...row })), {
      sheetRow: nextRow,
      division: team.division,
      franchise: team.franchise,
      teamRoleId: team.teamRoleId,
      team: team.teamRole,
      discordId,
      player: currentName.currentLeagueName,
      rosterStatus: 'Player',
    }],
    nameUpdates: snapshot.names.map((row) => row.sheetRow === currentName.sheetRow
      ? { ...row, franchise: team.franchise, leagueStatus: 'Player' }
      : { ...row }),
    publicChanges: [
      { division: team.division, area: 'free-agent', group: 'Free Agents', from: currentName.currentLeagueName, to: '' },
      { division: team.division, area: 'team', group: team.franchise, from: '', to: currentName.currentLeagueName },
    ],
    discordRoleChanges: [{ discordId, remove: [snapshot.freeAgentRoleId], add: [team.teamRoleId] }],
    teams: [team],
    players: [currentName.currentLeagueName],
    playerIds: [discordId],
  };
}

export function buildRenamePlan(snapshot: LeagueSnapshot, discordId: string, requestedName: string): LeagueMutationPlan {
  const nextName = requestedName.trim();
  if (!nextName) throw new Error('League name cannot be blank.');
  const current = currentNameRow(snapshot, discordId);
  const roster = snapshot.rosters.find((row) => row.discordId === discordId);
  if (current.currentLeagueName === nextName) throw new Error('That is already the player\'s Current League Name.');
  const existingAlias = snapshot.names.some((row) => row.discordId === discordId && row.knownName === current.currentLeagueName);
  return {
    kind: 'rename',
    rosters: snapshot.rosters.map((row) => row.discordId === discordId ? { ...row, player: nextName } : { ...row }),
    nameUpdates: snapshot.names.map((row) => row.discordId === discordId ? { ...row, currentLeagueName: nextName } : { ...row }),
    nameHistoryAppend: existingAlias ? undefined : {
      discordId,
      currentLeagueName: nextName,
      knownName: current.currentLeagueName,
      nameStatus: 'Previous / Alternate',
      division: current.division,
      franchise: current.franchise,
      leagueStatus: current.leagueStatus,
    },
    publicChanges: [{
      division: current.division,
      area: roster ? 'team' : 'free-agent',
      group: roster?.franchise ?? 'Free Agents',
      from: current.currentLeagueName,
      to: nextName,
    }],
    discordRoleChanges: [],
    teams: roster ? [requireTeam(snapshot, roster.teamRoleId)] : [],
    players: [nextName],
    playerIds: [discordId],
  };
}
