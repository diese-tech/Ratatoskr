import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type DiscordRoleChange, type LeagueMutationPlan, type LeagueSnapshot } from '../domain/leagueOperations.js';
import {
  createLeagueTransaction,
  hasSuccessfulLeagueAudit,
  listInterruptedLeagueTransactions,
  listPendingLeagueAnnouncements,
  markLeagueTransactionReconciliationRequired,
  recordLeagueAudit,
  transitionLeagueTransaction,
} from '../db/repositories/leagueOperations.js';
import {
  LeagueSheetDriftError,
  LeagueSheetReconciliationRequiredError,
  type LeagueTransactionRecord,
  type LoadedLeagueSnapshot,
  type PreparedLeagueSheetMutation,
} from './leagueSheets.js';

export type LeagueAnnouncement = {
  content: string;
  allowedRoleIds: string[];
  title: string;
  description: string;
  footer: string;
};

export interface LeagueSheetsPort {
  load(discordMembers: LeagueSnapshot['discordMembers'], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot>;
  assertUnchanged(loaded: LoadedLeagueSnapshot): Promise<void>;
  prepare(loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan): PreparedLeagueSheetMutation;
  apply(
    loaded: LoadedLeagueSnapshot,
    plan: LeagueMutationPlan,
    record: LeagueTransactionRecord,
    prepared: PreparedLeagueSheetMutation,
  ): Promise<void>;
  appendTransactionHistory(plan: LeagueMutationPlan, record: LeagueTransactionRecord): Promise<void>;
}

export interface LeagueDiscordPort {
  getMembers?(): Promise<LeagueSnapshot['discordMembers']>;
  applyRoleChange(change: DiscordRoleChange): Promise<void>;
  rollbackRoleChange(change: DiscordRoleChange): Promise<void>;
  announce(announcement: LeagueAnnouncement): Promise<string>;
}

type ExecuteLeagueTransactionInput = {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  actorUserId: string;
  actorName: string;
  freeAgentRoleId: string;
  now: Date;
  sheets: LeagueSheetsPort;
  discord: LeagueDiscordPort;
  buildPlan(snapshot: LeagueSnapshot): LeagueMutationPlan;
};

const activeGuilds = new WeakMap<object, Set<string>>();

function acquire(scope: object, guildId: string): () => void {
  let active = activeGuilds.get(scope);
  if (!active) { active = new Set(); activeGuilds.set(scope, active); }
  if (active.has(guildId)) throw new Error('Another league transaction is already running. Try again after it finishes.');
  active.add(guildId);
  return () => active!.delete(guildId);
}

function dateInLeagueTimezone(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function errorWithReference(error: unknown, reference: string): Error & { reference: string } {
  const result = error instanceof Error ? error : new Error(String(error));
  return Object.assign(result, { reference });
}

function assertDiscordPreconditions(snapshot: LeagueSnapshot, plan: LeagueMutationPlan): void {
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const teamsByRole = new Map(activeTeams.map((team) => [team.teamRoleId, team]));
  for (const discordId of plan.playerIds) {
    const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
    if (!member) throw new Error(`Discord member ${discordId} could not be loaded.`);
    const rosterRows = snapshot.rosters.filter((row) => row.discordId === discordId);
    if (rosterRows.length > 1) throw new Error(`Discord member ${discordId} has multiple roster assignments.`);
    const currentNames = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    if (currentNames.length !== 1) throw new Error(`Discord member ${discordId} must have exactly one current name record.`);
    const assignedTeamRoles = member.roleIds.filter((roleId) => teamsByRole.has(roleId));
    const roster = rosterRows[0];
    if (roster) {
      const expectedTeam = teamsByRole.get(roster.teamRoleId);
      if (!expectedTeam) throw new Error(`Discord member ${discordId} is rostered to an inactive or unknown team.`);
      if (assignedTeamRoles.length !== 1 || assignedTeamRoles[0] !== expectedTeam.teamRoleId) {
        throw new Error(`Discord member ${discordId} team roles do not match the current roster assignment.`);
      }
      if (member.roleIds.includes(snapshot.freeAgentRoleId)) {
        throw new Error(`Discord member ${discordId} cannot have both a team role and the Free Agent role.`);
      }
      if (!member.roleIds.includes(expectedTeam.divisionRoleId)) {
        throw new Error(`Discord member ${discordId} is missing the ${expectedTeam.division} division role.`);
      }
    } else {
      const currentName = currentNames[0]!;
      if (currentName.leagueStatus !== 'Free Agent') {
        throw new Error(`Discord member ${discordId} has no valid team or free-agent assignment.`);
      }
      if (assignedTeamRoles.length !== 0) {
        throw new Error(`Discord member ${discordId} is a free agent but still has a configured team role.`);
      }
      if (!member.roleIds.includes(snapshot.freeAgentRoleId)) {
        throw new Error(`Discord member ${discordId} is missing the Free Agent role.`);
      }
      const divisionRoleId = activeTeams.find((team) => team.division === currentName.division)?.divisionRoleId;
      if (!divisionRoleId || !member.roleIds.includes(divisionRoleId)) {
        throw new Error(`Discord member ${discordId} is missing the ${currentName.division} division role.`);
      }
    }
  }

  for (const change of plan.discordRoleChanges) {
    const member = snapshot.discordMembers.find((candidate) => candidate.discordId === change.discordId);
    if (!member) throw new Error(`Discord member ${change.discordId} could not be loaded.`);
    for (const roleId of change.remove) {
      if (!member.roleIds.includes(roleId)) throw new Error(`Discord member ${change.discordId} no longer has the expected role.`);
    }
    for (const roleId of change.add) {
      const isDivisionRole = plan.teams.some((team) => team.divisionRoleId === roleId);
      if (!isDivisionRole && member.roleIds.includes(roleId)) throw new Error(`Discord member ${change.discordId} already has the destination role.`);
    }
  }
}

export function buildLeagueAnnouncement(plan: LeagueMutationPlan, actorName: string): LeagueAnnouncement | undefined {
  const mention = (roleId: string) => `<@&${roleId}>`;
  if (plan.kind === 'rename') return undefined;
  if (plan.kind === 'trade') {
    const [firstTeam, secondTeam] = plan.teams;
    return {
      content: `${mention(firstTeam!.teamRoleId)} ${mention(secondTeam!.teamRoleId)}`,
      allowedRoleIds: [firstTeam!.teamRoleId, secondTeam!.teamRoleId],
      title: 'Word Travels the Branches',
      description: [
        `Ratatoskr carries news of an agreement between ${mention(firstTeam!.teamRoleId)} and ${mention(secondTeam!.teamRoleId)}.`,
        '',
        `<@${plan.playerIds[0]}> leaves ${mention(firstTeam!.teamRoleId)} to join ${mention(secondTeam!.teamRoleId)}.`,
        `<@${plan.playerIds[1]}> leaves ${mention(secondTeam!.teamRoleId)} to join ${mention(firstTeam!.teamRoleId)}.`,
      ].join('\n'),
      footer: `Posted by ${actorName}`,
    };
  }
  const team = plan.teams[0]!;
  const line = plan.kind === 'drop'
    ? `<@${plan.playerIds[0]}> leaves ${mention(team.teamRoleId)} and enters free agency.`
    : `<@${plan.playerIds[0]}> leaves free agency to join ${mention(team.teamRoleId)}.`;
  return {
    content: mention(team.teamRoleId),
    allowedRoleIds: [team.teamRoleId],
    title: 'Word Travels the Branches',
    description: `Ratatoskr carries word from ${mention(team.teamRoleId)}.\n\n${line}`,
    footer: `Posted by ${actorName}`,
  };
}

async function rollbackDiscord(discord: LeagueDiscordPort, applied: DiscordRoleChange[]): Promise<void> {
  for (const change of [...applied].reverse()) await discord.rollbackRoleChange(change);
}

export async function executeLeagueTransaction(input: ExecuteLeagueTransactionInput): Promise<{ reference: string; announcementId?: string }> {
  const release = acquire(input.operationScope, input.guildId);
  try {
    const members = input.discord.getMembers ? await input.discord.getMembers() : [];
    const loaded = await input.sheets.load(members, input.freeAgentRoleId);
    const auditDate = dateInLeagueTimezone(input.now);
    if (!hasSuccessfulLeagueAudit(input.db, input.guildId, auditDate)) {
      const issues = auditLeagueRoster(loaded.snapshot);
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: issues.length ? 'failed' : 'passed', issues });
      if (issues.length) throw new Error(`Daily league audit failed; nothing changed. ${issues.slice(0, 5).join(' ')}`);
    }
    const plan = input.buildPlan(loaded.snapshot);
    assertDiscordPreconditions(loaded.snapshot, plan);
    await input.sheets.assertUnchanged(loaded);
    const prepared = input.sheets.prepare(loaded, plan);

    const reference = `YSL-TRX-${auditDate.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const record: LeagueTransactionRecord = {
      reference, effectiveDate: auditDate, processedById: input.actorUserId, processedBy: input.actorName,
    };
    createLeagueTransaction(input.db, {
      reference, guildId: input.guildId, kind: plan.kind, actorUserId: input.actorUserId,
      payload: { plan, record },
    });

    const applied: DiscordRoleChange[] = [];
    try {
      for (const change of plan.discordRoleChanges) {
        await input.discord.applyRoleChange(change);
        applied.push(change);
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'reconciliationRequired' in error && error.reconciliationRequired === true) {
        markLeagueTransactionReconciliationRequired(input.db, reference, error instanceof Error ? error.message : String(error));
        throw errorWithReference(error, reference);
      }
      try {
        await rollbackDiscord(input.discord, applied);
        transitionLeagueTransaction(input.db, reference, 'applying_discord', 'failed', { errorMessage: String(error) });
      } catch (rollbackError) {
        markLeagueTransactionReconciliationRequired(input.db, reference, `Discord rollback failed: ${String(rollbackError)}`);
      }
      throw errorWithReference(error, reference);
    }

    transitionLeagueTransaction(input.db, reference, 'applying_discord', 'applying_sheets');
    try {
      await input.sheets.apply(loaded, plan, record, prepared);
    } catch (error) {
      if (error instanceof LeagueSheetDriftError) {
        try {
          await rollbackDiscord(input.discord, applied);
          transitionLeagueTransaction(input.db, reference, 'applying_sheets', 'failed', { errorMessage: error.message });
        } catch (rollbackError) {
          markLeagueTransactionReconciliationRequired(input.db, reference, `Discord rollback failed after sheet drift: ${String(rollbackError)}`);
        }
      } else {
        const message = error instanceof LeagueSheetReconciliationRequiredError ? error.message : String(error);
        markLeagueTransactionReconciliationRequired(input.db, reference, message);
      }
      throw errorWithReference(error, reference);
    }

    transitionLeagueTransaction(input.db, reference, 'applying_sheets', 'announcement_pending');
    const announcement = buildLeagueAnnouncement(plan, input.actorName);
    let announcementId: string | undefined;
    if (announcement) {
      try {
        announcementId = await input.discord.announce(announcement);
        record.announcementId = announcementId;
        transitionLeagueTransaction(input.db, reference, 'announcement_pending', 'announcement_pending', { announcementId });
      } catch (error) {
        throw errorWithReference(new Error(`Roster transaction completed, but its public notice is pending recovery: ${String(error)}`), reference);
      }
    }
    try {
      await input.sheets.appendTransactionHistory(plan, record);
    } catch (error) {
      throw errorWithReference(new Error(`Roster transaction completed, but its history row is pending recovery: ${String(error)}`), reference);
    }
    transitionLeagueTransaction(input.db, reference, 'announcement_pending', 'completed', { announcementId });
    return { reference, announcementId };
  } finally {
    release();
  }
}

type PendingPayload = { plan: LeagueMutationPlan; record: LeagueTransactionRecord };

function pendingPayload(value: unknown): PendingPayload {
  if (!value || typeof value !== 'object' || !('plan' in value) || !('record' in value)) {
    throw new Error('Stored transaction recovery payload is invalid.');
  }
  return value as PendingPayload;
}

export async function reconcilePendingLeagueTransactions(input: {
  db: Database.Database;
  sheets: LeagueSheetsPort;
  discord: LeagueDiscordPort;
  reportError?(reference: string, error: unknown): Promise<void>;
}): Promise<void> {
  for (const transaction of listInterruptedLeagueTransactions(input.db)) {
    const error = new Error(
      `League transaction was interrupted during ${transaction.status}. Discord roles and Google Sheets may be partially applied; manual reconciliation is required.`,
    );
    markLeagueTransactionReconciliationRequired(input.db, transaction.reference, error.message);
    console.error(`League transaction ${transaction.reference} requires reconciliation after restart`, error);
    await input.reportError?.(transaction.reference, error);
  }

  for (const transaction of listPendingLeagueAnnouncements(input.db)) {
    try {
      const { plan, record } = pendingPayload(transaction.payload);
      let announcementId = transaction.announcementId ?? undefined;
      const announcement = buildLeagueAnnouncement(plan, record.processedBy);
      if (announcement && !announcementId) {
        announcementId = await input.discord.announce(announcement);
        record.announcementId = announcementId;
        transitionLeagueTransaction(input.db, transaction.reference, 'announcement_pending', 'announcement_pending', { announcementId });
      } else if (announcementId) record.announcementId = announcementId;
      await input.sheets.appendTransactionHistory(plan, record);
      transitionLeagueTransaction(input.db, transaction.reference, 'announcement_pending', 'completed', { announcementId });
    } catch (error) {
      console.error(`League transaction recovery remains pending for ${transaction.reference}`, error);
      await input.reportError?.(transaction.reference, error);
    }
  }
}
