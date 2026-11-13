import { LEAGUE_DIVISIONS, LEAGUE_DIVISION_METADATA, compareDivisions, type LeagueDivision } from './leagueDivisions.js';

export type { LeagueDivision } from './leagueDivisions.js';

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
  nickname?: string | null;
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
export type DiscordNicknameChange = { discordId: string; before: string | null; beforeDisplayName: string; after: string };

export type LeagueMutationPlan = {
  kind: 'trade' | 'drop' | 'pickup' | 'rename' | 'departure' | 'self-drop' | 'reinstatement';
  reinstatement?: ReinstatementDetails;
  rosters: LeagueRosterRow[];
  nameUpdates: LeagueNameRow[];
  nameHistoryAppend?: Omit<LeagueNameRow, 'sheetRow'>;
  publicChanges: PublicRosterChange[];
  discordRoleChanges: DiscordRoleChange[];
  discordNicknameChange?: DiscordNicknameChange;
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
  options: { allowAbsentRosterMemberId?: string; allowDiscordNameRepairMemberId?: string; allowReinstatementMemberId?: string } = {},
): string[] {
  const issues: string[] = [];
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const teamsByRole = new Map<string, LeagueTeam>();
  const teamsByPublicBlock = new Map<string, LeagueTeam>();
  const roleByDivision = new Map<LeagueDivision, string>();
  const divisionByRole = new Map<string, LeagueDivision>();
  const configuredTeamRoleIds = new Set(activeTeams.map((team) => team.teamRoleId));
  const configuredDivisionRoleIds = new Set(activeTeams.map((team) => team.divisionRoleId));
  // Division roles a player's primary record is compared with; layered division roles are checked separately.
  const primaryDivisionRoleIds = new Set(activeTeams.filter((team) => !isLayeredDivision(team.division)).map((team) => team.divisionRoleId));
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
  const layeredById = new Map<string, LeagueRosterRow>();
  for (const row of snapshot.rosters) {
    if (isLayeredDivision(row.division)) {
      if (layeredById.has(row.discordId)) issues.push(`Discord member ${row.discordId} has more than one ${row.division} roster assignment.`);
      layeredById.set(row.discordId, row);
      const team = teamsByRole.get(row.teamRoleId);
      if (!team) issues.push(`Current Rosters member ${row.discordId} references an inactive or unknown team role.`);
      else if (row.division !== team.division || row.franchise !== team.franchise || row.team !== team.teamRole) {
        issues.push(`Current Rosters member ${row.discordId} does not match configured team ${team.teamRole}.`);
      }
      if (!names.get(row.discordId)) issues.push(`Current Rosters member ${row.discordId} has no Current League Name.`);
      // The layered row sits on an active primary record in the parent division (ADR 0002).
      const base = currentNameRows.get(row.discordId);
      const parent = LEAGUE_DIVISION_METADATA[row.division].layeredOn;
      if (!base?.length || (base.length === 1 && (base[0]!.division !== parent || !['Free Agent', 'Player', 'Captain'].includes(base[0]!.leagueStatus)))) {
        issues.push(`${row.division} roster member ${row.discordId} is not a current ${parent} player or free agent.`);
      }
      continue;
    }
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
    // A returning player's nickname is restored and verified by the reinstatement itself.
    if (!member || discordId === options.allowReinstatementMemberId) continue;
    const managedRows = [rosterById.get(discordId), layeredById.get(discordId)].filter((row) => row !== undefined);
    const managedNamesAgree = managedRows.every((row) => row.player === rows[0]!.currentLeagueName);
    const expectedDiscordRename = discordId === options.allowDiscordNameRepairMemberId && managedNamesAgree;
    if (!expectedDiscordRename
      && (rows[0]!.currentLeagueName !== member.displayName.trim() || managedRows.some((row) => row.player !== member.displayName.trim()))) {
      issues.push(`Managed player names for ${discordId} do not match the current Discord display name.`);
    }
  }

  for (const member of snapshot.discordMembers) {
    if (member.discordId === options.allowReinstatementMemberId) continue;
    const assignedTeamRoles = member.roleIds.filter((roleId) => teamsByRole.has(roleId) && !isLayeredDivision(teamsByRole.get(roleId)!.division));
    const roster = rosterById.get(member.discordId);
    issues.push(...layeredRoleIssues(member, layeredById.get(member.discordId), activeTeams));
    if (assignedTeamRoles.length > 1) issues.push(`Discord member ${member.discordId} has multiple team roles.`);
    if (assignedTeamRoles.length === 1 && roster?.teamRoleId !== assignedTeamRoles[0]) {
      issues.push(`Discord member ${member.discordId} team role does not match Current Rosters.`);
    }
    if (assignedTeamRoles.length === 0 && roster) issues.push(`Discord member ${member.discordId} is rostered without its team role.`);
    if (roster) {
      const team = teamsByRole.get(roster.teamRoleId);
      const assignedDivisionRoles = member.roleIds.filter((roleId) => primaryDivisionRoleIds.has(roleId));
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
    if (isLayeredDivision(row.division) && rosterById.has(row.discordId)) continue;
    if (!memberById.has(row.discordId) && row.discordId !== options.allowAbsentRosterMemberId) {
      issues.push(`Current Rosters member ${row.discordId} is not in the Discord member snapshot.`);
    }
  }
  for (const rows of currentNameRows.values()) {
    if (rows.length !== 1 || rows[0]!.leagueStatus !== 'Free Agent') continue;
    const row = rows[0]!;
    if (row.discordId === options.allowReinstatementMemberId) continue;
    if (row.franchise.trim() !== '') {
      issues.push(`Current free agent ${row.discordId} must not retain a franchise assignment.`);
    }
    const member = memberById.get(row.discordId);
    if (!member) {
      // A departing free agent on a Niflheim team is the exit being processed (#200).
      if (row.discordId !== options.allowAbsentRosterMemberId) issues.push(`Current free agent ${row.discordId} is not in the Discord member snapshot.`);
      continue;
    }
    const divisionRoleId = activeTeams.find((team) => team.division === row.division)?.divisionRoleId;
    const assignedDivisionRoles = member.roleIds.filter((roleId) => primaryDivisionRoleIds.has(roleId));
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
  for (const division of LEAGUE_DIVISIONS.filter((name) => LEAGUE_DIVISION_METADATA[name].hasPublicFreeAgentList)) {
    const expected = snapshot.names
      .filter((row) => row.nameStatus === 'Current Discord Name' && row.division === division && row.leagueStatus === 'Free Agent')
      .map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    if (hasDuplicateNames(expected)) issues.push(`${division} free agents have duplicate current player names.`);
    if (!sameNames(expected, actual)) issues.push(`${division} public free-agent list does not match Player Name History.`);
  }
  return issues;
}

// A member holds a layered division's team and division role exactly when they have its roster row.
function layeredRoleIssues(member: DiscordLeagueMember, row: LeagueRosterRow | undefined, activeTeams: LeagueTeam[]): string[] {
  const issues: string[] = [];
  for (const division of LEAGUE_DIVISIONS.filter(isLayeredDivision)) {
    const teams = activeTeams.filter((team) => team.division === division);
    if (!teams.length) continue;
    const mine = row?.division === division ? row : undefined;
    const teamRoles = member.roleIds.filter((roleId) => teams.some((team) => team.teamRoleId === roleId));
    if (teamRoles.length > 1) issues.push(`Discord member ${member.discordId} has multiple ${division} team roles.`);
    else if (teamRoles.length === 1 && teamRoles[0] !== mine?.teamRoleId) {
      issues.push(`Discord member ${member.discordId} ${division} team role does not match Current Rosters.`);
    } else if (!teamRoles.length && mine) issues.push(`Discord member ${member.discordId} is on a ${division} roster without its team role.`);
    if (member.roleIds.includes(teams[0]!.divisionRoleId) !== Boolean(mine)) {
      issues.push(`Discord member ${member.discordId} ${division} division role does not match Current Rosters.`);
    }
  }
  return issues;
}

// A layered division (Niflheim) is a second membership on top of the player's
// record in another division (#198, ADR 0002). "Primary" rows are everything else
// and keep every pre-Niflheim behavior; layered rows are handled explicitly.
export function isLayeredDivision(division: LeagueDivision): boolean {
  return LEAGUE_DIVISION_METADATA[division].layeredOn !== undefined;
}

export function primaryRoster(rows: readonly LeagueRosterRow[], discordId: string): LeagueRosterRow | undefined {
  return rows.find((row) => row.discordId === discordId && !isLayeredDivision(row.division));
}

export function layeredRoster(rows: readonly LeagueRosterRow[], discordId: string): LeagueRosterRow | undefined {
  return rows.find((row) => row.discordId === discordId && isLayeredDivision(row.division));
}

// Read-only action eligibility from persisted observations; never execution authority.
// A primary free agent may also have a layered team, without a primary roster row.
export function currentLeagueMembership(snapshot: Pick<LeagueSnapshot, 'rosters' | 'names'>, discordId: string) {
  const rows = snapshot.rosters.filter(row => row.discordId === discordId);
  const names = snapshot.names.filter(row => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
  if (names.length !== 1 || rows.filter(row => !isLayeredDivision(row.division)).length > 1
    || rows.filter(row => isLayeredDivision(row.division)).length > 1) return;
  const name = names[0]!;
  const primary = primaryRoster(rows, discordId);
  const layered = layeredRoster(rows, discordId);
  if (primary ? name.division !== primary.division || name.franchise !== primary.franchise
    || name.leagueStatus !== primary.rosterStatus || name.currentLeagueName !== primary.player
    : name.leagueStatus !== 'Free Agent' || !!name.franchise || isLayeredDivision(name.division)) return;
  if (layered && (LEAGUE_DIVISION_METADATA[layered.division].layeredOn !== name.division
    || layered.player !== name.currentLeagueName)) return;
  return { name, primary, layered };
}

// The roster row a change targets (#200). A layered player can hold a primary row and
// a Niflheim row; `division` picks one, and without it the player must have only one.
function targetRoster(snapshot: LeagueSnapshot, discordId: string, division?: LeagueDivision): LeagueRosterRow {
  const rows = snapshot.rosters.filter((row) => row.discordId === discordId);
  if (rows.filter((row) => !isLayeredDivision(row.division)).length > 1 || rows.filter((row) => isLayeredDivision(row.division)).length > 1)
    throw new Error(`${discordId} has multiple roster assignments.`);
  const matches = rows.filter((row) => !division || row.division === division);
  if (!matches.length) {
    throw new LeagueMutationValidationError(division
      ? `<@${discordId}> is not on a ${division} team.`
      : `<@${discordId}> is not rostered on an active YSL team.`);
  }
  if (matches.length > 1) {
    const divisions = matches.map((row) => row.division).sort(compareDivisions);
    throw new LeagueMutationValidationError(
      `<@${discordId}> plays in ${divisions.join(' and ')}. Choose the division option to say which team this change is for.`);
  }
  return matches[0]!;
}

function rostersOf(snapshot: LeagueSnapshot, discordId: string): LeagueRosterRow[] {
  return snapshot.rosters.filter((row) => row.discordId === discordId);
}

// Without a chosen division, a two-player trade uses the one division both players share.
function tradeRosters(snapshot: LeagueSnapshot, firstId: string, secondId: string, division?: LeagueDivision) {
  const shared = rostersOf(snapshot, firstId).map((row) => row.division)
    .filter((candidate) => rostersOf(snapshot, secondId).some((row) => row.division === candidate));
  const chosen = division ?? (shared.length === 1 ? shared[0] : undefined);
  return [targetRoster(snapshot, firstId, chosen), targetRoster(snapshot, secondId, chosen)] as const;
}

function crossDivisionTrade(from: LeagueDivision, to: LeagueDivision): LeagueMutationValidationError {
  return new LeagueMutationValidationError(
    `Cross-division trades aren't allowed. ${from} and ${to} are separate rosters, so trades stay inside one division.`);
}

// Niflheim pickups and replacements come from the parent division's free-agent pool (#195).
function layeredSourceName(snapshot: LeagueSnapshot, discordId: string, team: LeagueTeam): LeagueNameRow {
  const parent = LEAGUE_DIVISION_METADATA[team.division].layeredOn!;
  if (layeredRoster(snapshot.rosters, discordId)) throw new LeagueMutationValidationError(`<@${discordId}> is already on a ${team.division} team.`);
  const name = currentNameRow(snapshot, discordId);
  if (name.division !== parent) {
    throw new LeagueMutationValidationError(`${team.division} players come from the ${parent} free-agent pool. <@${discordId}> plays in ${name.division}.`);
  }
  if (primaryRoster(snapshot.rosters, discordId) || name.leagueStatus !== 'Free Agent') {
    throw new LeagueMutationValidationError(`Only ${parent} free agents can join a ${team.division} team. <@${discordId}> is not a ${parent} free agent.`);
  }
  const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
  if (!member?.roleIds.includes(snapshot.freeAgentRoleId)) throw new LeagueMutationValidationError('The selected player does not have the Free Agent role.');
  if (teamAreaUsesName(snapshot, team.teamRoleId, name.currentLeagueName)) {
    throw new LeagueMutationValidationError('That player name is already used in the destination roster area.');
  }
  return name;
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
    && !primaryRoster(snapshot.rosters, row.discordId));
}

export function buildTradePlan(snapshot: LeagueSnapshot, firstId: string, secondId: string, division?: LeagueDivision): LeagueMutationPlan {
  if (firstId === secondId) throw new LeagueMutationValidationError('A trade requires two different players.');
  const [first, second] = tradeRosters(snapshot, firstId, secondId, division);
  const firstTeam = requireTeam(snapshot, first.teamRoleId);
  const secondTeam = requireTeam(snapshot, second.teamRoleId);
  if (firstTeam.division !== secondTeam.division) throw crossDivisionTrade(firstTeam.division, secondTeam.division);
  // A layered (Niflheim) trade changes only its own rows; the primary name record stays.
  const layered = isLayeredDivision(firstTeam.division);
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
    rosters: snapshot.rosters.map((row) => row.sheetRow === first.sheetRow ? replaceRosterTeam(row, secondTeam) : row.sheetRow === second.sheetRow ? replaceRosterTeam(row, firstTeam) : { ...row }),
    nameUpdates: snapshot.names.map((row) => layered ? { ...row } : row.discordId === firstId && row.nameStatus === 'Current Discord Name'
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

export function isOneWayTrade(plan: LeagueMutationPlan): boolean {
  return plan.kind === 'trade' && plan.playerIds.length === 1;
}

export function buildOneWayTradePlan(snapshot: LeagueSnapshot, playerId: string, receivingRoleId: string): LeagueMutationPlan {
  // The receiving team names the division, so a layered player needs no extra choice.
  const receiver = requireTeam(snapshot, receivingRoleId);
  const roster = rostersOf(snapshot, playerId).find((row) => row.division === receiver.division) ?? targetRoster(snapshot, playerId);
  const sender = requireTeam(snapshot, roster.teamRoleId);
  if (sender.division !== receiver.division) throw crossDivisionTrade(sender.division, receiver.division);
  if (sender.teamRoleId === receiver.teamRoleId) throw new LeagueMutationValidationError('The player is already on the receiving team.');
  const member = snapshot.discordMembers.find(candidate => candidate.discordId === playerId);
  if (!member) throw new LeagueMutationValidationError('That player is not currently in the Discord server.');
  if (!member.roleIds.includes(sender.teamRoleId)) throw new LeagueMutationValidationError('The player does not have their current team role.');
  const name = currentNameRow(snapshot, playerId);
  if (teamAreaUsesName(snapshot, receiver.teamRoleId, name.currentLeagueName)) {
    throw new LeagueMutationValidationError('A traded player name is already used in the destination roster area.');
  }
  return {
    kind: 'trade',
    rosters: snapshot.rosters.map(row => row.sheetRow === roster.sheetRow ? replaceRosterTeam(row, receiver) : { ...row }),
    nameUpdates: snapshot.names.map(row => row.sheetRow === name.sheetRow && !isLayeredDivision(receiver.division)
      ? { ...row, franchise: receiver.franchise } : { ...row }),
    publicChanges: [
      { division: sender.division, area: 'team', group: sender.franchise, from: name.currentLeagueName, to: '' },
      { division: receiver.division, area: 'team', group: receiver.franchise, from: '', to: name.currentLeagueName },
    ],
    discordRoleChanges: [{ discordId: playerId, remove: [sender.teamRoleId], add: [receiver.teamRoleId] }],
    teams: [sender, receiver],
    players: [name.currentLeagueName],
    playerIds: [playerId],
  };
}

type ExitKind = 'drop' | 'departure' | 'self-drop';

function buildExitPlan(
  snapshot: LeagueSnapshot,
  kind: ExitKind,
  discordId: string,
  replacementId?: string,
  division?: LeagueDivision,
): LeagueMutationPlan {
  if (replacementId === discordId) throw new LeagueMutationValidationError('The outgoing player cannot replace themselves.');
  // A drop ends one membership. Departure and self-drop end every membership; the targeted
  // one (the primary by default) is named first and receives any replacement (#200).
  const exitsLeague = kind !== 'drop';
  const roster = targetRoster(snapshot, discordId, division ?? (exitsLeague ? primaryRoster(snapshot.rosters, discordId)?.division : undefined));
  const layered = isLayeredDivision(roster.division);
  if (kind === 'departure' && snapshot.discordMembers.some((member) => member.discordId === discordId)) {
    throw new LeagueMutationValidationError('That player is still in the YSL server. Use `/transaction drop` or `/transaction self-drop`.');
  }
  const team = requireTeam(snapshot, roster.teamRoleId);
  const leaving = exitsLeague ? [roster, ...rostersOf(snapshot, discordId).filter((row) => row !== roster)] : [roster];
  const leavingTeams = leaving.map((row) => requireTeam(snapshot, row.teamRoleId));
  const currentName = currentNameRow(snapshot, discordId);
  const wasFreeAgent = !primaryRoster(snapshot.rosters, discordId) && currentName.leagueStatus === 'Free Agent';
  if (kind === 'drop' && !layered && freeAgentAreaUsesName(snapshot, team.division, currentName.currentLeagueName)) {
    throw new LeagueMutationValidationError('That player name is already used in the destination free-agent area.');
  }

  let replacementName: LeagueNameRow | undefined;
  if (replacementId && layered) {
    replacementName = layeredSourceName(snapshot, replacementId, team);
  } else if (replacementId) {
    if (primaryRoster(snapshot.rosters, replacementId)) {
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
    .filter((row) => !leaving.includes(row))
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

  const publicChanges: PublicRosterChange[] = leaving.map((row) => ({
    division: row.division,
    area: 'team',
    group: row.franchise,
    from: currentName.currentLeagueName,
    to: row === roster ? replacementName?.currentLeagueName ?? '' : '',
  }));
  if (exitsLeague && wasFreeAgent) {
    publicChanges.push({ division: currentName.division, area: 'free-agent', group: 'Free Agents', from: currentName.currentLeagueName, to: '' });
  }
  // Niflheim has no free-agent list, and a Niflheim replacement stays a parent free agent.
  if (!layered && kind === 'drop') {
    publicChanges.push({
      division: team.division,
      area: 'free-agent',
      group: 'Free Agents',
      from: replacementName?.currentLeagueName ?? '',
      to: currentName.currentLeagueName,
    });
  } else if (!layered && replacementName) {
    publicChanges.push({
      division: team.division,
      area: 'free-agent',
      group: 'Free Agents',
      from: replacementName.currentLeagueName,
      to: '',
    });
  }

  const outgoingMemberPresent = snapshot.discordMembers.some((member) => member.discordId === discordId);
  // A layered membership's team and division roles go together; Free Agent and the
  // parent division role are never touched by a Niflheim drop.
  const leavingRoles = leavingTeams.flatMap((entry) => isLayeredDivision(entry.division) ? [entry.teamRoleId, entry.divisionRoleId] : [entry.teamRoleId]);
  const discordRoleChanges = kind === 'departure' || (kind === 'self-drop' && !outgoingMemberPresent) ? [] : [{
    discordId,
    remove: exitsLeague && wasFreeAgent ? [...leavingRoles, snapshot.freeAgentRoleId] : leavingRoles,
    add: kind === 'drop' && !layered ? [snapshot.freeAgentRoleId] : [],
  }];
  if (replacementId) {
    discordRoleChanges.push(layered
      ? { discordId: replacementId, remove: [], add: [team.teamRoleId, team.divisionRoleId] }
      : { discordId: replacementId, remove: [snapshot.freeAgentRoleId], add: [team.teamRoleId] });
  }

  return {
    kind,
    rosters: nextRosters,
    nameUpdates: snapshot.names.map((row) => row.sheetRow === currentName.sheetRow && (exitsLeague || !layered)
      ? { ...row, franchise: '', leagueStatus: outgoingStatus }
      : replacementName && !layered && row.sheetRow === replacementName.sheetRow
        ? { ...row, franchise: team.franchise, leagueStatus: 'Player' }
        : { ...row }),
    publicChanges,
    discordRoleChanges,
    teams: leavingTeams,
    players: [currentName.currentLeagueName, ...(replacementName ? [replacementName.currentLeagueName] : [])],
    playerIds: [discordId, ...(replacementId ? [replacementId] : [])],
  };
}

export function buildDropPlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string, division?: LeagueDivision): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'drop', discordId, replacementId, division);
}

export function buildDeparturePlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string, division?: LeagueDivision): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'departure', discordId, replacementId, division);
}

export function buildSelfDropPlan(snapshot: LeagueSnapshot, discordId: string, replacementId?: string, division?: LeagueDivision): LeagueMutationPlan {
  return buildExitPlan(snapshot, 'self-drop', discordId, replacementId, division);
}

export function buildPickupPlan(snapshot: LeagueSnapshot, discordId: string, teamRoleId: string): LeagueMutationPlan {
  const target = snapshot.teams.find((candidate) => candidate.active && candidate.teamRoleId === teamRoleId);
  if (target && isLayeredDivision(target.division)) return buildLayeredPickupPlan(snapshot, discordId, target);
  if (primaryRoster(snapshot.rosters, discordId)) throw new LeagueMutationValidationError('The selected player is not a free agent.');
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

// A Niflheim pickup adds a second membership: the player stays a parent-division free
// agent (Free Agent role, parent division role and free-agent list unchanged).
function buildLayeredPickupPlan(snapshot: LeagueSnapshot, discordId: string, team: LeagueTeam): LeagueMutationPlan {
  const name = layeredSourceName(snapshot, discordId, team);
  const nextRow = Math.max(5, ...snapshot.rosters.map((row) => row.sheetRow)) + 1;
  return {
    kind: 'pickup',
    rosters: [...snapshot.rosters.map((row) => ({ ...row })), {
      sheetRow: nextRow, division: team.division, franchise: team.franchise, teamRoleId: team.teamRoleId,
      team: team.teamRole, discordId, player: name.currentLeagueName, rosterStatus: 'Player',
    }],
    nameUpdates: snapshot.names.map((row) => ({ ...row })),
    publicChanges: [{ division: team.division, area: 'team', group: team.franchise, from: '', to: name.currentLeagueName }],
    discordRoleChanges: [{ discordId, remove: [], add: [team.teamRoleId, team.divisionRoleId] }],
    teams: [team],
    players: [name.currentLeagueName],
    playerIds: [discordId],
  };
}

export function buildRenamePlan(snapshot: LeagueSnapshot, discordId: string, requestedName: string, allowUnchangedName = false): LeagueMutationPlan {
  const nextName = requestedName.trim();
  if (!nextName) throw new LeagueMutationValidationError('League name cannot be blank.');
  const current = currentNameRow(snapshot, discordId);
  const roster = primaryRoster(snapshot.rosters, discordId);
  const layered = layeredRoster(snapshot.rosters, discordId);
  if (current.currentLeagueName === nextName && !allowUnchangedName) throw new LeagueMutationValidationError('That is already the player\'s Current League Name.');
  const nameUsedInSameArea = snapshot.names.some((row) => {
    if (row.discordId === discordId || row.nameStatus !== 'Current Discord Name' || row.currentLeagueName !== nextName) return false;
    const otherRoster = primaryRoster(snapshot.rosters, row.discordId);
    return (layered && layeredRoster(snapshot.rosters, row.discordId)?.teamRoleId === layered.teamRoleId) || (roster
      ? otherRoster?.teamRoleId === roster.teamRoleId
      : !otherRoster && row.leagueStatus === 'Free Agent' && row.division === current.division);
  });
  if (nameUsedInSameArea) throw new LeagueMutationValidationError('That league name is already used by another player in this roster area.');
  const existingAlias = current.currentLeagueName === nextName || snapshot.names.some((row) => row.discordId === discordId && row.knownName === current.currentLeagueName);
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
    // One league name per person: a layered player's Niflheim block is renamed too.
    publicChanges: current.currentLeagueName === nextName ? [] : [{
      division: current.division,
      area: roster ? 'team' : 'free-agent',
      group: roster?.franchise ?? 'Free Agents',
      from: current.currentLeagueName,
      to: nextName,
    }, ...(layered ? [{
      division: layered.division, area: 'team' as const, group: layered.franchise, from: current.currentLeagueName, to: nextName,
    }] : [])],
    discordRoleChanges: [],
    teams: [...(roster ? [requireTeam(snapshot, roster.teamRoleId)] : []), ...(layered ? [requireTeam(snapshot, layered.teamRoleId)] : [])],
    players: [nextName],
    playerIds: [discordId],
  };
}

export function buildStaffRenamePlan(snapshot: LeagueSnapshot, discordId: string, requestedName: string): LeagueMutationPlan {
  const member = snapshot.discordMembers.find(candidate => candidate.discordId === discordId);
  if (!member) throw new LeagueMutationValidationError('That player is not currently in the Discord server.');
  if (member.nickname === undefined) throw new LeagueMutationValidationError('The current Discord nickname could not be verified. Request a fresh preview.');
  const name = requestedName.trim();
  if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name))
    throw new LeagueMutationValidationError('The new player nickname must contain 1–32 characters without control characters.');
  return { ...buildRenamePlan(snapshot, discordId, name, member.nickname !== name),
    discordNicknameChange: { discordId, before: member.nickname, beforeDisplayName: member.displayName, after: name } };
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

export type ReinstatementSource = {
  reference: string; playerId: string; playerName?: string; kind: 'drop' | 'departure' | 'self-drop';
  effectiveDate: string; processedBy: string; processedById: string;
  teamRoleId: string; franchise: string; division: LeagueDivision; resultingStatus: string;
  completedAt?: string; announcementId?: string;
  /** The Niflheim team the original exit also removed (#200); restored by the return. */
  layeredTeamRoleId?: string;
};
export type ReinstatementSelection = {
  version: 1; kind: 'reinstate'; playerId: string; sourceReference: string;
  teamRoleId: string; returnStatus: 'Player'; effectiveDate: string;
  overrides: string[]; preserveFutureSanction: true; reason?: string;
};
export type ReinstatementDetails = {
  selection: ReinstatementSelection; source: ReinstatementSource; currentStatus: string;
  advisories: { id: string; text: string }[]; blockers: string[];
  beforeManagedRoleIds: string[]; sourceFingerprint?: string;
  /** Present only when the verified Discord display name differs from the recorded league name. */
  nicknameRestore?: { currentDisplayName: string; restoredName: string };
};

// Policy decisions are explicit staff choices. Structural checks cannot be overridden.
export function buildReinstatementPlan(snapshot: LeagueSnapshot, selection: ReinstatementSelection,
  source: ReinstatementSource): LeagueMutationPlan {
  if (source.playerId !== selection.playerId || source.reference !== selection.sourceReference
    || source.teamRoleId !== selection.teamRoleId || selection.returnStatus !== 'Player'
    || selection.preserveFutureSanction !== true)
    throw new LeagueMutationValidationError('The selected player, original action or return decision changed. Review a fresh preview.');
  if (primaryRoster(snapshot.rosters, selection.playerId))
    throw new LeagueMutationValidationError('This player is already rostered. Review the current assignment; no reinstatement is needed.');
  const name = currentNameRow(snapshot, selection.playerId);
  if (name.franchise || name.leagueStatus !== source.resultingStatus || name.division !== source.division)
    throw new LeagueMutationValidationError('The original exit no longer matches this player’s recorded status. Ask staff to reconcile the history first.');
  const team = requireTeam(snapshot, selection.teamRoleId);
  if (team.franchise !== source.franchise || team.division !== source.division)
    throw new LeagueMutationValidationError('The original team changed. Ask staff to review the team configuration first.');
  if (teamAreaUsesName(snapshot, team.teamRoleId, name.currentLeagueName))
    throw new LeagueMutationValidationError('Another player already uses this name in the destination roster. Resolve the identity conflict first.');
  const member = snapshot.discordMembers.find(row => row.discordId === selection.playerId);
  const managed = new Set([snapshot.freeAgentRoleId, ...snapshot.teams.filter(t => t.active && !isLayeredDivision(t.division)).flatMap(t => [t.teamRoleId, t.divisionRoleId])]);
  const before = (member?.roleIds ?? []).filter(id => managed.has(id)).sort();
  if (snapshot.teams.some(t => t.active && !isLayeredDivision(t.division) && before.includes(t.teamRoleId)))
    throw new LeagueMutationValidationError('This player already has a team role without a roster assignment. Reconcile the records first.');
  // Identity is the Discord ID and verified exit, never the name. If the player changed their
  // Discord name while away, the same transaction sets their server nickname back to the
  // recorded league name; Sheets and history keep that name unchanged (#189).
  const recordedName = name.currentLeagueName;
  const nicknameChange: DiscordNicknameChange | undefined = member && member.displayName.trim() !== recordedName ? (() => {
    if (member.nickname === undefined)
      throw new LeagueMutationValidationError('The player’s current Discord nickname could not be checked. Request a fresh preview.');
    if (!recordedName.trim() || recordedName.length > 32 || /[\u0000-\u001f\u007f]/.test(recordedName))
      throw new LeagueMutationValidationError('The recorded league name cannot be used as a Discord nickname. Ask staff to correct Player Name History first.');
    return { discordId: selection.playerId, before: member.nickname, beforeDisplayName: member.displayName, after: recordedName };
  })() : undefined;
  const advisories: ReinstatementDetails['advisories'] = [];
  const count = snapshot.rosters.filter(row => row.teamRoleId === team.teamRoleId).length;
  if (count >= 7) advisories.push({ id: 'roster-count', text: `Roster count: ${count}/7 before return. Staff may approve a policy exception; the public block still needs an empty owned cell.` });
  if (/suspend|ban|self-drop/i.test(name.leagueStatus)) advisories.push({ id: 'discipline', text: `Restore current-season Player status despite ${name.leagueStatus}. The original sanction and any next-season penalty remain recorded and are not waived.` });
  const blockers = member ? [] : ['This player is absent from Discord. Ask them to rejoin, then request a fresh preview. Rat cannot safely save a roster return with roles still pending.'];
  // Restore exactly what the exit removed, including a Niflheim membership (#200).
  const layeredTeam = source.layeredTeamRoleId ? snapshot.teams.find(t => t.active && t.teamRoleId === source.layeredTeamRoleId) : undefined;
  if (source.layeredTeamRoleId && !layeredTeam)
    throw new LeagueMutationValidationError('The player’s Niflheim team no longer exists, so Rat cannot restore everything the original exit removed. Ask staff to review the Niflheim teams first.');
  if (layeredTeam && (layeredRoster(snapshot.rosters, selection.playerId)
    || member?.roleIds.some(id => id === layeredTeam.divisionRoleId || snapshot.teams.some(t => t.active && isLayeredDivision(t.division) && t.teamRoleId === id))))
    throw new LeagueMutationValidationError('This player already has a Niflheim team or role. Reconcile the current assignment first.');
  if (layeredTeam && teamAreaUsesName(snapshot, layeredTeam.teamRoleId, name.currentLeagueName))
    throw new LeagueMutationValidationError('Another player already uses this name in the Niflheim roster. Resolve the identity conflict first.');
  const nextRow = Math.max(5, ...snapshot.rosters.map(row => row.sheetRow)) + 1;
  const returned = (entry: LeagueTeam, sheetRow: number): LeagueRosterRow => ({
    sheetRow, division: entry.division, franchise: entry.franchise, teamRoleId: entry.teamRoleId,
    team: entry.teamRole, discordId: selection.playerId, player: name.currentLeagueName, rosterStatus: 'Player',
  });
  return { kind: 'reinstatement', rosters: [...snapshot.rosters.map(row => ({ ...row })), returned(team, nextRow),
    ...(layeredTeam ? [returned(layeredTeam, nextRow + 1)] : [])],
    nameUpdates: snapshot.names.map(row => row.sheetRow === name.sheetRow ? { ...row, franchise: team.franchise, leagueStatus: 'Player' } : { ...row }),
    publicChanges: [
      ...(name.leagueStatus === 'Free Agent' ? [{ division: name.division, area: 'free-agent' as const, group: 'Free Agents', from: name.currentLeagueName, to: '' }] : []),
      { division: team.division, area: 'team', group: team.franchise, from: '', to: name.currentLeagueName },
      ...(layeredTeam ? [{ division: layeredTeam.division, area: 'team' as const, group: layeredTeam.franchise, from: '', to: name.currentLeagueName }] : []),
    ], discordRoleChanges: member ? [{ discordId: selection.playerId,
      remove: before.filter(id => id !== team.teamRoleId && id !== team.divisionRoleId),
      add: [team.teamRoleId, team.divisionRoleId].filter(id => !before.includes(id))
        .concat(layeredTeam ? [layeredTeam.teamRoleId, layeredTeam.divisionRoleId] : []) }] : [],
    ...(nicknameChange ? { discordNicknameChange: nicknameChange } : {}),
    teams: [team, ...(layeredTeam ? [layeredTeam] : [])], players: [name.currentLeagueName], playerIds: [selection.playerId],
    reinstatement: { selection, source, currentStatus: name.leagueStatus, advisories, blockers, beforeManagedRoleIds: before,
      ...(nicknameChange ? { nicknameRestore: { currentDisplayName: nicknameChange.beforeDisplayName, restoredName: recordedName } } : {}) },
  };
}

// Timing is informational. Older saved intents may retain a timing marker as
// provenance, but it never becomes a required exception or a selectable override.
export function reinstatementPolicyExceptions(details: Pick<ReinstatementDetails, 'advisories'>) {
  return details.advisories.filter(item => item.id !== 'timing');
}
