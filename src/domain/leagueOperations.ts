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
  kind: 'trade' | 'drop' | 'pickup' | 'rename' | 'departure' | 'self-drop';
  rosters: LeagueRosterRow[];
  nameUpdates: LeagueNameRow[];
  nameHistoryAppend?: Omit<LeagueNameRow, 'sheetRow'>;
  publicChanges: PublicRosterChange[];
  discordRoleChanges: DiscordRoleChange[];
  teams: LeagueTeam[];
  players: string[];
  playerIds: string[];
};

export const SELF_DROP_LEAGUE_STATUS = 'Suspended - Self-Drop (Current + Next Season)';

export class LeagueMutationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeagueMutationValidationError';
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].map((value) => value.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function sameNames(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasDuplicateNames(values: Iterable<string>): boolean {
  const names = [...values].map((value) => value.trim()).filter(Boolean);
  return new Set(names).size !== names.length;
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

export function auditLeagueRoster(
  snapshot: LeagueSnapshot,
  options: { allowAbsentRosterMemberId?: string; allowDiscordNameRepairMemberId?: string } = {},
): string[] {
  const issues: string[] = [];
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const teamsByRole = new Map<string, LeagueTeam>();
  const teamsByPublicBlock = new Map<string, LeagueTeam>();
  const roleByDivision = new Map<LeagueDivision, string>();
  const divisionByRole = new Map<string, LeagueDivision>();
  const configuredTeamRoleIds = new Set(activeTeams.map((team) => team.teamRoleId));
  const configuredDivisionRoleIds = new Set(activeTeams.map((team) => team.divisionRoleId));
  for (const roleId of configuredTeamRoleIds) {
    if (configuredDivisionRoleIds.has(roleId)) {
      issues.push(`Role ${roleId} is configured as both a team role and a division role.`);
    }
  }
  if (configuredTeamRoleIds.has(snapshot.freeAgentRoleId)) {
    issues.push(`Free Agent role ${snapshot.freeAgentRoleId} is also configured as a team role.`);
  }
  if (configuredDivisionRoleIds.has(snapshot.freeAgentRoleId)) {
    issues.push(`Free Agent role ${snapshot.freeAgentRoleId} is also configured as a division role.`);
  }
  for (const team of activeTeams) {
    if (teamsByRole.has(team.teamRoleId)) issues.push(`Team role ${team.teamRoleId} is configured more than once.`);
    teamsByRole.set(team.teamRoleId, team);
    const publicBlockKey = `${team.division}\u0000${team.franchise}`;
    if (teamsByPublicBlock.has(publicBlockKey)) {
      issues.push(`${team.division} ${team.franchise} is configured as more than one active team.`);
    }
    teamsByPublicBlock.set(publicBlockKey, team);
    const configuredRole = roleByDivision.get(team.division);
    if (configuredRole && configuredRole !== team.divisionRoleId) {
      issues.push(`${team.division} is configured with more than one division role.`);
    }
    roleByDivision.set(team.division, team.divisionRoleId);
    const configuredDivision = divisionByRole.get(team.divisionRoleId);
    if (configuredDivision && configuredDivision !== team.division) {
      issues.push(`Division role ${team.divisionRoleId} is shared by ${configuredDivision} and ${team.division}.`);
    }
    divisionByRole.set(team.divisionRoleId, team.division);
  }

  let names: Map<string, string>;
  try { names = canonicalNames(snapshot); }
  catch (error) { issues.push(error instanceof Error ? error.message : String(error)); names = new Map(); }

  const rosterById = new Map<string, LeagueRosterRow>();
  const rosterCountById = new Map<string, number>();
  const currentNameRows = new Map<string, LeagueNameRow[]>();
  const memberById = new Map(snapshot.discordMembers.map((member) => [member.discordId, member]));
  for (const row of snapshot.names) {
    if (row.nameStatus !== 'Current Discord Name') continue;
    const rows = currentNameRows.get(row.discordId) ?? [];
    rows.push(row);
    currentNameRows.set(row.discordId, rows);
  }
  for (const [discordId, rows] of currentNameRows) {
    if (rows.length !== 1) issues.push(`Discord member ${discordId} must have exactly one current name record.`);
  }
  for (const row of snapshot.rosters) {
    rosterCountById.set(row.discordId, (rosterCountById.get(row.discordId) ?? 0) + 1);
    if (rosterById.has(row.discordId)) issues.push(`Discord member ${row.discordId} appears more than once in Current Rosters.`);
    rosterById.set(row.discordId, row);
    const team = teamsByRole.get(row.teamRoleId);
    if (!team) issues.push(`Current Rosters member ${row.discordId} references an inactive or unknown team role.`);
    else if (row.division !== team.division || row.franchise !== team.franchise || row.team !== team.teamRole) {
      issues.push(`Current Rosters member ${row.discordId} does not match configured team ${team.teamRole}.`);
    }
    const canonicalName = names.get(row.discordId);
    if (!canonicalName) issues.push(`Current Rosters member ${row.discordId} has no Current League Name.`);
    const memberCurrentNames = currentNameRows.get(row.discordId) ?? [];
    if (memberCurrentNames.length === 0) {
      issues.push(`Discord member ${row.discordId} must have exactly one current name record.`);
    } else if (memberCurrentNames.length === 1) {
      const currentName = memberCurrentNames[0]!;
      if (currentName.division !== row.division
        || currentName.franchise !== row.franchise
        || currentName.leagueStatus !== row.rosterStatus) {
        issues.push(`Current name record for ${row.discordId} does not match its Current Rosters assignment.`);
      }
    }
  }
  for (const [discordId, rows] of currentNameRows) {
    if (rows.length !== 1 || !['Captain', 'Player'].includes(rows[0]!.leagueStatus)) continue;
    if (rosterCountById.get(discordId) !== 1) {
      issues.push(`Current player ${discordId} must have exactly one Current Rosters assignment.`);
    }
  }

  for (const [discordId, rows] of currentNameRows) {
    if (rows.length !== 1 || !['Captain', 'Player', 'Free Agent'].includes(rows[0]!.leagueStatus)) continue;
    const member = memberById.get(discordId);
    if (!member) continue;
    const roster = rosterById.get(discordId);
    const managedNamesAgree = !roster || roster.player === rows[0]!.currentLeagueName;
    const expectedDiscordRename = discordId === options.allowDiscordNameRepairMemberId && managedNamesAgree;
    if (!expectedDiscordRename
      && (rows[0]!.currentLeagueName !== member.displayName || (roster && roster.player !== member.displayName))) {
      issues.push(`Managed player names for ${discordId} do not match the current Discord display name.`);
    }
  }

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
    if (!memberById.has(row.discordId) && row.discordId !== options.allowAbsentRosterMemberId) {
      issues.push(`Current Rosters member ${row.discordId} is not in the Discord member snapshot.`);
    }
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
    const publicDivision = snapshot.publicRosters[team.division];
    const hasPublicBlock = publicDivision !== undefined
      && Object.prototype.hasOwnProperty.call(publicDivision.teams, team.franchise);
    if (!hasPublicBlock) {
      issues.push(`${team.division} ${team.franchise} has no managed public roster block.`);
    }
    const actual = publicDivision?.teams[team.franchise] ?? [];
    if (hasDuplicateNames(expected)) {
      issues.push(`${team.division} ${team.franchise} has duplicate current player names.`);
    }
    if (!sameNames(expected, actual)) issues.push(`${team.division} ${team.franchise} public roster does not match Current Rosters.`);
  }
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const) {
    const expected = snapshot.names
      .filter((row) => row.nameStatus === 'Current Discord Name' && row.division === division && row.leagueStatus === 'Free Agent')
      .map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    if (hasDuplicateNames(expected)) issues.push(`${division} free agents have duplicate current player names.`);
    if (!sameNames(expected, actual)) issues.push(`${division} public free-agent list does not match Player Name History.`);
  }
  return issues;
}

function requireRoster(snapshot: LeagueSnapshot, discordId: string): LeagueRosterRow {
  const rows = snapshot.rosters.filter((row) => row.discordId === discordId);
  if (!rows.length) throw new LeagueMutationValidationError(`<@${discordId}> is not rostered on an active YSL team.`);
  if (rows.length !== 1) throw new Error(`${discordId} has multiple roster assignments.`);
  return rows[0]!;
}

function requireTeam(snapshot: LeagueSnapshot, roleId: string): LeagueTeam {
  const team = snapshot.teams.find((candidate) => candidate.active && candidate.teamRoleId === roleId);
  if (!team) throw new LeagueMutationValidationError('The selected role is not an active YSL team role.');
  return team;
}

function currentNameRow(snapshot: LeagueSnapshot, discordId: string): LeagueNameRow {
  const rows = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
  if (!rows.length) throw new LeagueMutationValidationError(`<@${discordId}> is not registered in Player Name History.`);
  if (rows.length !== 1) throw new Error(`${discordId} has multiple current name records.`);
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
  if (firstId === secondId) throw new LeagueMutationValidationError('A trade requires two different players.');
  const first = requireRoster(snapshot, firstId);
  const second = requireRoster(snapshot, secondId);
  const firstTeam = requireTeam(snapshot, first.teamRoleId);
  const secondTeam = requireTeam(snapshot, second.teamRoleId);
  if (firstTeam.division !== secondTeam.division) throw new LeagueMutationValidationError('Cross-division trades are not supported.');
  if (firstTeam.teamRoleId === secondTeam.teamRoleId) throw new LeagueMutationValidationError('Both players are already on the same team.');
  const names = canonicalNames(snapshot);
  const firstName = names.get(firstId)!;
  const secondName = names.get(secondId)!;
  if (teamAreaUsesName(snapshot, secondTeam.teamRoleId, firstName, new Set([secondId]))
    || teamAreaUsesName(snapshot, firstTeam.teamRoleId, secondName, new Set([firstId]))) {
    throw new LeagueMutationValidationError('A traded player name is already used in the destination roster area.');
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

type ExitKind = 'drop' | 'departure' | 'self-drop';

function buildExitPlan(
  snapshot: LeagueSnapshot,
  kind: ExitKind,
  discordId: string,
  replacementId?: string,
): LeagueMutationPlan {
  if (replacementId === discordId) throw new LeagueMutationValidationError('The outgoing player cannot replace themselves.');
  const roster = requireRoster(snapshot, discordId);
  if (kind === 'departure' && snapshot.discordMembers.some((member) => member.discordId === discordId)) {
    throw new LeagueMutationValidationError('That player is still in the YSL server. Use `/transaction drop` or `/transaction self-drop`.');
  }
  const team = requireTeam(snapshot, roster.teamRoleId);
  const currentName = currentNameRow(snapshot, discordId);
  if (kind === 'drop' && freeAgentAreaUsesName(snapshot, team.division, currentName.currentLeagueName)) {
    throw new LeagueMutationValidationError('That player name is already used in the destination free-agent area.');
  }

  let replacementName: LeagueNameRow | undefined;
  if (replacementId) {
    if (snapshot.rosters.some((row) => row.discordId === replacementId)) {
      throw new LeagueMutationValidationError('The selected replacement is not a free agent.');
    }
    replacementName = currentNameRow(snapshot, replacementId);
    if (replacementName.leagueStatus !== 'Free Agent') {
      throw new LeagueMutationValidationError('The selected replacement is not a free agent.');
    }
    if (replacementName.division !== team.division) {
      throw new LeagueMutationValidationError('Cross-division replacements are not supported.');
    }
    const member = snapshot.discordMembers.find((candidate) => candidate.discordId === replacementId);
    if (!member?.roleIds.includes(snapshot.freeAgentRoleId)) {
      throw new LeagueMutationValidationError('The selected replacement does not have the Free Agent role.');
    }
    if (teamAreaUsesName(snapshot, team.teamRoleId, replacementName.currentLeagueName, new Set([discordId]))) {
      throw new LeagueMutationValidationError('That player name is already used in the destination roster area.');
    }
  }

  const outgoingStatus = kind === 'drop'
    ? 'Free Agent'
    : kind === 'departure' ? 'Inactive' : SELF_DROP_LEAGUE_STATUS;
  const nextRosters = snapshot.rosters
    .filter((row) => row.discordId !== discordId)
    .map((row) => ({ ...row }));
  if (replacementId && replacementName) {
    nextRosters.push({
      sheetRow: roster.sheetRow,
      division: team.division,
      franchise: team.franchise,
      teamRoleId: team.teamRoleId,
      team: team.teamRole,
      discordId: replacementId,
      player: replacementName.currentLeagueName,
      rosterStatus: 'Player',
    });
    nextRosters.sort((left, right) => left.sheetRow - right.sheetRow);
  }

  const publicChanges: PublicRosterChange[] = [{
    division: team.division,
    area: 'team',
    group: team.franchise,
    from: currentName.currentLeagueName,
    to: replacementName?.currentLeagueName ?? '',
  }];
  if (kind === 'drop') {
    publicChanges.push({
      division: team.division,
      area: 'free-agent',
      group: 'Free Agents',
      from: replacementName?.currentLeagueName ?? '',
      to: currentName.currentLeagueName,
    });
  } else if (replacementName) {
    publicChanges.push({
      division: team.division,
      area: 'free-agent',
      group: 'Free Agents',
      from: replacementName.currentLeagueName,
      to: '',
    });
  }

  const outgoingMemberPresent = snapshot.discordMembers.some((member) => member.discordId === discordId);
  const discordRoleChanges = kind === 'departure' || (kind === 'self-drop' && !outgoingMemberPresent) ? [] : [{
    discordId,
    remove: [team.teamRoleId],
    add: kind === 'drop' ? [snapshot.freeAgentRoleId] : [],
  }];
  if (replacementId) {
    discordRoleChanges.push({ discordId: replacementId, remove: [snapshot.freeAgentRoleId], add: [team.teamRoleId] });
  }

  return {
    kind,
    rosters: nextRosters,
    nameUpdates: snapshot.names.map((row) => row.sheetRow === currentName.sheetRow
      ? { ...row, franchise: '', leagueStatus: outgoingStatus }
      : replacementName && row.sheetRow === replacementName.sheetRow
        ? { ...row, franchise: team.franchise, leagueStatus: 'Player' }
        : { ...row }),
    publicChanges,
    discordRoleChanges,
    teams: [team],
    players: [currentName.currentLeagueName, ...(replacementName ? [replacementName.currentLeagueName] : [])],
    playerIds: [discordId, ...(replacementId ? [replacementId] : [])],
  };
}

export function buildDropPlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'drop', discordId, replacementId);
}

export function buildDeparturePlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'departure', discordId, replacementId);
}

export function buildSelfDropPlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'self-drop', discordId, replacementId);
}

export function buildPickupPlan(snapshot: LeagueSnapshot, discordId: string, teamRoleId: string): LeagueMutationPlan {
  if (snapshot.rosters.some((row) => row.discordId === discordId)) throw new LeagueMutationValidationError('The selected player is not a free agent.');
  const team = requireTeam(snapshot, teamRoleId);
  const currentName = currentNameRow(snapshot, discordId);
  if (currentName.leagueStatus !== 'Free Agent') throw new LeagueMutationValidationError('The selected player is not a free agent.');
  if (currentName.division !== team.division) throw new LeagueMutationValidationError('Cross-division pickups are not supported.');
  if (teamAreaUsesName(snapshot, team.teamRoleId, currentName.currentLeagueName)) {
    throw new LeagueMutationValidationError('That player name is already used in the destination roster area.');
  }
  const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
  if (!member?.roleIds.includes(snapshot.freeAgentRoleId)) throw new LeagueMutationValidationError('The selected player does not have the Free Agent role.');
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
  if (!nextName) throw new LeagueMutationValidationError('League name cannot be blank.');
  const current = currentNameRow(snapshot, discordId);
  const roster = snapshot.rosters.find((row) => row.discordId === discordId);
  if (current.currentLeagueName === nextName) throw new LeagueMutationValidationError('That is already the player\'s Current League Name.');
  const nameUsedInSameArea = snapshot.names.some((row) => {
    if (row.discordId === discordId || row.nameStatus !== 'Current Discord Name' || row.currentLeagueName !== nextName) return false;
    const otherRoster = snapshot.rosters.find((candidate) => candidate.discordId === row.discordId);
    return roster
      ? otherRoster?.teamRoleId === roster.teamRoleId
      : !otherRoster && row.leagueStatus === 'Free Agent' && row.division === current.division;
  });
  if (nameUsedInSameArea) throw new LeagueMutationValidationError('That league name is already used by another player in this roster area.');
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

export function buildDiscordRenamePlan(
  snapshot: LeagueSnapshot,
  discordId: string,
  requestedName: string,
): LeagueMutationPlan {
  const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
  if (!member) throw new LeagueMutationValidationError('That player is not currently in the Discord server.');
  const discordName = member.displayName.trim();
  if (!discordName) throw new LeagueMutationValidationError('That player does not have a usable Discord display name.');
  if (requestedName.trim() !== discordName) {
    throw new LeagueMutationValidationError(
      `The new league name must exactly match the player's current Discord display name: ${discordName}.`,
    );
  }
  return buildRenamePlan(snapshot, discordId, discordName);
}
