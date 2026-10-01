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
  const configuredDivisionRoleIds = new Set(activeTeams.map((team) => team.divisionRoleId));
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
    } else {
      const currentName = currentNameRows.get(row.discordId)![0]!;
      if (currentName.division !== row.division
        || currentName.franchise !== row.franchise
        || currentName.leagueStatus !== row.rosterStatus) {
        issues.push(`Current name record for ${row.discordId} does not match its Current Rosters assignment.`);
      }
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
      const assignedDivisionRoles = member.roleIds.filter((roleId) => configuredDivisionRoleIds.has(roleId));
      if (team && (assignedDivisionRoles.length !== 1 || assignedDivisionRoles[0] !== team.divisionRoleId)) {
        issues.push(`Discord member ${member.discordId} division roles do not match ${team.division}.`);
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
    if (row.franchise.trim() !== '') {
      issues.push(`Current free agent ${row.discordId} must not retain a franchise assignment.`);
    }
    const member = memberById.get(row.discordId);
    if (!member) {
      issues.push(`Current free agent ${row.discordId} is not in the Discord member snapshot.`);
      continue;
    }
    const divisionRoleId = activeTeams.find((team) => team.division === row.division)?.divisionRoleId;
    const assignedDivisionRoles = member.roleIds.filter((roleId) => configuredDivisionRoleIds.has(roleId));
    if (!divisionRoleId || assignedDivisionRoles.length !== 1 || assignedDivisionRoles[0] !== divisionRoleId) {
      issues.push(`Discord member ${row.discordId} division roles do not match ${row.division}.`);
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

function teamAreaUsesName(
  snapshot: LeagueSnapshot,
  teamRoleId: string,
  name: string,
  excludedDiscordIds: ReadonlySet<string> = new Set(),
): boolean {
  return snapshot.rosters.some((row) => row.teamRoleId === teamRoleId
    && !excludedDiscordIds.has(row.discordId)
    && currentNameRow(snapshot, row.discordId).currentLeagueName === name);
}

function freeAgentAreaUsesName(snapshot: LeagueSnapshot, division: LeagueDivision, name: string): boolean {
  return snapshot.names.some((row) => row.nameStatus === 'Current Discord Name'
    && row.leagueStatus === 'Free Agent'
    && row.division === division
    && row.currentLeagueName === name
    && !snapshot.rosters.some((roster) => roster.discordId === row.discordId));
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
  if (teamAreaUsesName(snapshot, secondTeam.teamRoleId, firstName, new Set([secondId]))
    || teamAreaUsesName(snapshot, firstTeam.teamRoleId, secondName, new Set([firstId]))) {
    throw new Error('A traded player name is already used in the destination roster area.');
  }
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
  if (freeAgentAreaUsesName(snapshot, team.division, currentName.currentLeagueName)) {
    throw new Error('That player name is already used in the destination free-agent area.');
  }
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
  if (teamAreaUsesName(snapshot, team.teamRoleId, currentName.currentLeagueName)) {
    throw new Error('That player name is already used in the destination roster area.');
  }
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
  const nameUsedInSameArea = snapshot.names.some((row) => {
    if (row.discordId === discordId || row.nameStatus !== 'Current Discord Name' || row.currentLeagueName !== nextName) return false;
    const otherRoster = snapshot.rosters.find((candidate) => candidate.discordId === row.discordId);
    return roster
      ? otherRoster?.teamRoleId === roster.teamRoleId
      : !otherRoster && row.leagueStatus === 'Free Agent' && row.division === current.division;
  });
  if (nameUsedInSameArea) throw new Error('That league name is already used by another player in this roster area.');
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
