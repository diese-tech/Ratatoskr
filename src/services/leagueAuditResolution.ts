import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  auditLeagueRoster,
  buildRenamePlan,
  LeagueMutationValidationError,
  type DiscordRoleChange,
  type LeagueDivision,
  type LeagueMutationPlan,
  type LeagueSnapshot,
  type PublicRosterChange,
} from '../domain/leagueOperations.js';
import type { LeagueRoleState } from './leagueTransactions.js';
import type { DiscordLeagueMember } from '../domain/leagueOperations.js';
import {
  LeagueSheetDriftError,
  type LoadedLeagueSnapshot,
  type LeagueTransactionRecord,
  type PreparedLeagueSheetMutation,
} from './leagueSheets.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import {
  completeLeagueAuditRepair,
  createLeagueAuditRepair,
  failLeagueAuditRepair,
  markLeagueAuditRepairReconciliationRequired,
} from '../db/repositories/leagueAuditRepairs.js';
import { createOrGetLeagueReconciliationTicket } from '../db/repositories/leagueOperations.js';

export type LeagueAuditRepairAction = 'use-discord-name' | 'use-league-name' | 'use-roster-name' | 'sync-public-roster' | 'mark-inactive';
export type LeagueAuditResolutionAction = LeagueAuditRepairAction | 'repair-roles';

export class LeagueAuditRepairNoWriteError extends Error {}

export class LeagueAuditRepairStaleError extends LeagueAuditRepairNoWriteError {
  constructor() {
    super('This issue changed since this review page opened. Review the refreshed audit before trying again.');
    this.name = 'LeagueAuditRepairStaleError';
  }
}

function publicChanges(
  division: LeagueDivision,
  area: 'team' | 'free-agent',
  group: string,
  actual: string[],
  expected: string[],
): PublicRosterChange[] {
  const remainingExpected = [...expected];
  const extra: string[] = [];
  for (const value of actual) {
    const index = remainingExpected.indexOf(value);
    if (index >= 0) remainingExpected.splice(index, 1);
    else extra.push(value);
  }
  const changes: PublicRosterChange[] = [];
  const paired = Math.min(extra.length, remainingExpected.length);
  for (let index = 0; index < paired; index += 1) {
    changes.push({ division, area, group, from: extra[index]!, to: remainingExpected[index]! });
  }
  for (const value of extra.slice(paired)) changes.push({ division, area, group, from: value, to: '' });
  for (const value of remainingExpected.slice(paired)) changes.push({ division, area, group, from: '', to: value });
  return changes;
}

function basePlan(snapshot: LeagueSnapshot, publicRosterChanges: PublicRosterChange[]): LeagueMutationPlan {
  return {
    kind: 'rename',
    rosters: snapshot.rosters.map((row) => ({ ...row })),
    nameUpdates: snapshot.names.map((row) => ({ ...row })),
    publicChanges: publicRosterChanges,
    discordRoleChanges: [],
    teams: [],
    players: [],
    playerIds: [],
  };
}

export function buildLeagueAuditSheetRepair(
  snapshot: LeagueSnapshot,
  diagnostic: string,
  action: LeagueAuditRepairAction,
): LeagueMutationPlan {
  const discordNameMatch = diagnostic.match(/^Managed player names for (\S+) do not match the current Discord display name\.$/);
  if (discordNameMatch && action === 'use-discord-name') {
    const discordId = discordNameMatch[1]!;
    const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
    const name = snapshot.names.find((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    const roster = snapshot.rosters.find((row) => row.discordId === discordId);
    if (!member || !name) throw new LeagueAuditRepairNoWriteError('That player no longer has both a Discord account and one current name record.');
    const target = member.displayName.trim();
    if (!target) throw new LeagueAuditRepairNoWriteError('Discord does not currently provide a usable display name for that player.');

    if (name.currentLeagueName !== target) {
      const plan = buildRenamePlan(snapshot, discordId, target);
      const publicNames = roster
        ? snapshot.publicRosters[roster.division]?.teams[roster.franchise] ?? []
        : snapshot.publicRosters[name.division]?.freeAgents ?? [];
      if (publicNames.includes(target)) {
        plan.publicChanges = [];
      } else if (!publicNames.includes(name.currentLeagueName) && roster && publicNames.includes(roster.player)) {
        plan.publicChanges = [{
          division: roster.division, area: 'team', group: roster.franchise,
          from: roster.player, to: target,
        }];
      } else if (!publicNames.includes(name.currentLeagueName)) {
        plan.publicChanges = [];
      }
      return plan;
    }

    const plan = basePlan(snapshot, []);
    plan.rosters = snapshot.rosters.map((row) => row.discordId === discordId ? { ...row, player: target } : { ...row });
    if (roster && roster.player !== target) {
      const publicTeam = snapshot.publicRosters[roster.division]?.teams[roster.franchise] ?? [];
      if (publicTeam.includes(roster.player)) {
        plan.publicChanges = [{
          division: roster.division, area: 'team', group: roster.franchise,
          from: roster.player, to: target,
        }];
      }
    }
    plan.teams = roster ? snapshot.teams.filter((team) => team.teamRoleId === roster.teamRoleId) : [];
    plan.players = [target];
    plan.playerIds = [discordId];
    return plan;
  }

  const nameMatch = diagnostic.match(/^Current Rosters player name for (\S+) does not match its Current League Name\.$/);
  if (nameMatch && (action === 'use-league-name' || action === 'use-roster-name')) {
    const discordId = nameMatch[1]!;
    const roster = snapshot.rosters.find((row) => row.discordId === discordId);
    const name = snapshot.names.find((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    if (!roster || !name) throw new Error('That player no longer has both a roster row and a current name row.');
    if (action === 'use-roster-name') {
      const plan = buildRenamePlan(snapshot, discordId, roster.player);
      const publicTeam = snapshot.publicRosters[roster.division]?.teams[roster.franchise] ?? [];
      if (!publicTeam.includes(name.currentLeagueName)) plan.publicChanges = [];
      return plan;
    }
    const plan = basePlan(snapshot, []);
    plan.rosters = snapshot.rosters.map((row) => row.discordId === discordId ? { ...row, player: name.currentLeagueName } : { ...row });
    const publicTeam = snapshot.publicRosters[roster.division]?.teams[roster.franchise] ?? [];
    if (publicTeam.includes(roster.player) && roster.player !== name.currentLeagueName) {
      plan.publicChanges = [{
        division: roster.division, area: 'team', group: roster.franchise,
        from: roster.player, to: name.currentLeagueName,
      }];
    }
    plan.teams = snapshot.teams.filter((team) => team.teamRoleId === roster.teamRoleId);
    plan.players = [name.currentLeagueName];
    plan.playerIds = [discordId];
    return plan;
  }

  const teamMatch = diagnostic.match(/^(Vanaheim|Alfheim|Svartalfheim) (.+) public roster does not match Current Rosters\.$/);
  if (teamMatch && action === 'sync-public-roster') {
    const division = teamMatch[1] as LeagueDivision;
    const franchise = teamMatch[2]!;
    const team = snapshot.teams.find((entry) => entry.active && entry.division === division && entry.franchise === franchise);
    if (!team) throw new Error('That public roster block no longer maps to one active team.');
    const names = new Map(snapshot.names
      .filter((row) => row.nameStatus === 'Current Discord Name')
      .map((row) => [row.discordId, row.currentLeagueName]));
    const rosterRows = snapshot.rosters.filter((row) => row.teamRoleId === team.teamRoleId);
    if (rosterRows.some((row) => names.get(row.discordId) !== row.player)) {
      throw new LeagueAuditRepairNoWriteError(
        'This team has a conflicting player-name issue. Resolve the player-name issue first; no changes were made.',
      );
    }
    const expected = rosterRows.map((row) => row.player);
    const actual = snapshot.publicRosters[division]?.teams[franchise] ?? [];
    const plan = basePlan(snapshot, publicChanges(division, 'team', franchise, actual, expected));
    plan.teams = [team];
    return plan;
  }

  const freeAgentMatch = diagnostic.match(/^(Vanaheim|Alfheim|Svartalfheim) public free-agent list does not match Player Name History\.$/);
  if (freeAgentMatch && action === 'sync-public-roster') {
    const division = freeAgentMatch[1] as LeagueDivision;
    const expected = snapshot.names.filter((row) => row.nameStatus === 'Current Discord Name'
      && row.division === division && row.leagueStatus === 'Free Agent').map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    return basePlan(snapshot, publicChanges(division, 'free-agent', 'Free Agents', actual, expected));
  }

  const absentFreeAgent = diagnostic.match(/^Current free agent (\S+) is not in the Discord member snapshot\.$/);
  if (absentFreeAgent && action === 'mark-inactive') {
    const discordId = absentFreeAgent[1]!;
    const name = snapshot.names.find((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    if (!name || name.leagueStatus !== 'Free Agent') throw new Error('That player is no longer recorded as a current free agent.');
    const plan = basePlan(snapshot, []);
    plan.kind = 'departure';
    plan.nameUpdates = snapshot.names.map((row) => row.sheetRow === name.sheetRow
      ? { ...row, franchise: '', leagueStatus: 'Inactive' }
      : { ...row });
    if ((snapshot.publicRosters[name.division]?.freeAgents ?? []).includes(name.currentLeagueName)) {
      plan.publicChanges = [{
        division: name.division, area: 'free-agent', group: 'Free Agents',
        from: name.currentLeagueName, to: '',
      }];
    }
    plan.players = [name.currentLeagueName];
    plan.playerIds = [discordId];
    return plan;
  }

  throw new Error('This issue cannot be repaired with that Discord action.');
}

export function buildManagedRoleRepair(snapshot: LeagueSnapshot, discordId: string): DiscordRoleChange {
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
  const expected = buildManagedRoleState(snapshot, discordId);
  if (!member) throw new LeagueAuditRepairNoWriteError('That player is no longer available for a Discord role repair.');
  const expectedTeamRoleId = expected.expectedTeamRoleId ?? undefined;
  const expectedDivisionRoleId = expected.divisionRoleId;
  const expectsFreeAgent = expected.expectsFreeAgent;
  const managedTeamRoleIds = new Set(activeTeams.map((entry) => entry.teamRoleId));
  const managedDivisionRoleIds = new Set(activeTeams.map((entry) => entry.divisionRoleId));
  const remove = member.roleIds.filter((roleId) => (managedTeamRoleIds.has(roleId) && roleId !== expectedTeamRoleId)
    || (managedDivisionRoleIds.has(roleId) && roleId !== expectedDivisionRoleId)
    || (roleId === snapshot.freeAgentRoleId && !expectsFreeAgent));
  const add = [
    ...(expectedTeamRoleId && !member.roleIds.includes(expectedTeamRoleId) ? [expectedTeamRoleId] : []),
    ...(!member.roleIds.includes(expectedDivisionRoleId) ? [expectedDivisionRoleId] : []),
    ...(expectsFreeAgent && !member.roleIds.includes(snapshot.freeAgentRoleId) ? [snapshot.freeAgentRoleId] : []),
  ];
  return { discordId, remove, add };
}

export function buildManagedRoleState(snapshot: LeagueSnapshot, discordId: string): LeagueRoleState {
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const currentNames = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
  if (currentNames.length !== 1) {
    throw new LeagueAuditRepairNoWriteError('This player does not have exactly one current name record. Resolve Player Name History first.');
  }
  const currentName = currentNames[0]!;
  const rosterRows = snapshot.rosters.filter((row) => row.discordId === discordId);
  if (rosterRows.length > 1) {
    throw new LeagueAuditRepairNoWriteError('This player has more than one current roster assignment. Resolve Current Rosters first.');
  }
  const roster = rosterRows[0];
  const teamMatches = roster ? activeTeams.filter((entry) => entry.teamRoleId === roster.teamRoleId) : [];
  if (roster && teamMatches.length !== 1) {
    throw new LeagueAuditRepairNoWriteError('This player roster points to an ambiguous or inactive team role. Resolve League Teams first.');
  }
  const team = teamMatches[0];
  const divisionRoleIds = [...new Set(activeTeams
    .filter((entry) => entry.division === currentName.division)
    .map((entry) => entry.divisionRoleId))];
  const divisionRoleId = team?.divisionRoleId ?? (divisionRoleIds.length === 1 ? divisionRoleIds[0] : undefined);
  if (!divisionRoleId) {
    throw new LeagueAuditRepairNoWriteError('The expected division role is not configured unambiguously. Resolve League Teams first.');
  }
  return {
    configuredTeamRoleIds: activeTeams.map((entry) => entry.teamRoleId),
    expectedTeamRoleId: team?.teamRoleId ?? null,
    configuredDivisionRoleIds: [...new Set(activeTeams.map((entry) => entry.divisionRoleId))],
    freeAgentRoleId: snapshot.freeAgentRoleId,
    expectsFreeAgent: !roster && currentName.leagueStatus === 'Free Agent',
    divisionRoleId,
  };
}

type RepairSheets = {
  load(members: DiscordLeagueMember[], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot>;
  prepare(loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan): PreparedLeagueSheetMutation;
  apply(
    loaded: LoadedLeagueSnapshot,
    plan: LeagueMutationPlan,
    record: LeagueTransactionRecord,
    prepared: PreparedLeagueSheetMutation,
  ): Promise<void>;
};

type RepairDiscord = {
  validateDisplayName(discordId: string, expectedDisplayName: string): Promise<void>;
  reconcileManagedRoles(
    change: DiscordRoleChange,
    expected: LeagueRoleState,
    observedManagedRoleIds: string[],
  ): Promise<void>;
};

function leagueDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

class LeagueAuditRepairReconciliationError extends Error {
  readonly leagueReconciliationTicket = true;

  constructor(message: string, readonly reference: string) {
    super(message);
    this.name = 'LeagueAuditRepairReconciliationError';
  }
}

function repairFailureMessage(error: unknown): string {
  return `League audit repair may be partial: ${error instanceof Error ? error.message : String(error)}`;
}

async function applyDurableRepair(input: {
  db: Database.Database;
  reference: string;
  guildId: string;
  auditReference: string;
  actorUserId: string;
  expectedFinding: string;
  action: LeagueAuditResolutionAction;
  apply: () => Promise<void>;
}): Promise<void> {
  createLeagueAuditRepair(input.db, {
    reference: input.reference,
    guildId: input.guildId,
    auditReference: input.auditReference,
    actorUserId: input.actorUserId,
    finding: input.expectedFinding,
    action: input.action,
  });
  try {
    await input.apply();
    if (!completeLeagueAuditRepair(input.db, input.reference)) {
      throw new Error('The repair result could not be marked complete in Ratatoskr.');
    }
  } catch (error) {
    if (error instanceof LeagueMutationValidationError
      || error instanceof LeagueSheetDriftError
      || error instanceof LeagueAuditRepairNoWriteError) {
      failLeagueAuditRepair(input.db, input.reference, error.message);
      throw new LeagueAuditRepairNoWriteError(error.message);
    }
    const message = repairFailureMessage(error);
    markLeagueAuditRepairReconciliationRequired(input.db, input.reference, message);
    createOrGetLeagueReconciliationTicket(input.db, {
      reference: input.reference,
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      fingerprint: `audit-repair:${input.reference}`,
      summary: `${input.expectedFinding} ${message}`,
    });
    throw new LeagueAuditRepairReconciliationError(message, input.reference);
  }
}

export async function executeLeagueAuditRepair(input: {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  auditReference: string;
  actorUserId: string;
  actorName: string;
  now: Date;
  expectedFinding: string;
  action: LeagueAuditResolutionAction;
  freeAgentRoleId: string;
  members: { getMembers(): Promise<DiscordLeagueMember[]> };
  sheets: RepairSheets;
  discord: RepairDiscord;
}): Promise<{ reference: string }> {
  const release = acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    const members = await input.members.getMembers();
    const loaded = await input.sheets.load(members, input.freeAgentRoleId);
    const diagnostic = auditLeagueRoster(loaded.snapshot).find((candidate) =>
      humanizeLeagueAuditIssues(loaded.snapshot, [candidate])[0] === input.expectedFinding);
    if (!diagnostic) throw new LeagueAuditRepairStaleError();
    const reference = `YSL-AUD-FIX-${randomUUID().slice(0, 8).toUpperCase()}`;
    if (input.action === 'repair-roles') {
      const match = diagnostic.match(/^Discord member (\S+)/);
      if (!match) throw new Error('This issue no longer identifies one player whose Discord roles can be repaired.');
      const discordId = match[1]!;
      const change = buildManagedRoleRepair(loaded.snapshot, discordId);
      const expected = buildManagedRoleState(loaded.snapshot, discordId);
      const member = loaded.snapshot.discordMembers.find((entry) => entry.discordId === discordId)!;
      const managedRoleIds = new Set([
        ...expected.configuredTeamRoleIds,
        ...expected.configuredDivisionRoleIds,
        expected.freeAgentRoleId,
      ]);
      const observedManagedRoleIds = member.roleIds.filter((roleId) => managedRoleIds.has(roleId));
      await applyDurableRepair({
        ...input,
        reference,
        apply: () => input.discord.reconcileManagedRoles(change, expected, observedManagedRoleIds),
      });
      return { reference };
    }
    const plan = buildLeagueAuditSheetRepair(loaded.snapshot, diagnostic, input.action);
    const prepared = input.sheets.prepare(loaded, plan);
    await applyDurableRepair({
      ...input,
      reference,
      apply: async () => {
        if (input.action === 'use-discord-name') {
          await input.discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
        }
        await input.sheets.apply(loaded, plan, {
          reference,
          effectiveDate: leagueDate(input.now),
          processedById: input.actorUserId,
          processedBy: input.actorName,
          approvalNote: 'Ratatoskr approved roster audit repair',
        }, prepared);
      },
    });
    return { reference };
  } finally {
    release();
  }
}
