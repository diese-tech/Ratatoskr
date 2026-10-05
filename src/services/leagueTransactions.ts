import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type DiscordRoleChange, type LeagueMutationPlan, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import {
  createLeagueTransaction,
  createOrGetLeagueReconciliationTicket,
  getLeagueReconciliationTicket,
  listInterruptedLeagueTransactions,
  listPendingLeagueAnnouncements,
  listUndeliveredLeagueReconciliationTickets,
  markLeagueReconciliationTicketAlerted,
  markLeagueTransactionReconciliationAlerted,
  markLeagueTransactionReconciliationRequired,
  recordLeagueAudit,
  resolveOpenLeagueReconciliationTickets,
  transitionLeagueTransaction,
} from '../db/repositories/leagueOperations.js';
import {
  LeagueSheetDriftError,
  LeagueSheetReconciliationRequiredError,
  type LeagueTransactionRecord,
  type LoadedLeagueSnapshot,
  type PreparedLeagueSheetMutation,
} from './leagueSheets.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import {
  listIncompleteLeagueAuditRepairs,
  markLeagueAuditRepairReconciliationRequired,
} from '../db/repositories/leagueAuditRepairs.js';

export type LeagueAnnouncement = {
  content: string;
  allowedRoleIds: string[];
  title: string;
  description: string;
  footer: string;
};

export type LeagueRoleState = {
  configuredTeamRoleIds: string[];
  expectedTeamRoleId: string | null;
  configuredDivisionRoleIds: string[];
  freeAgentRoleId: string;
  expectsFreeAgent: boolean;
  divisionRoleId: string;
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
  validateMemberAbsent(discordId: string): Promise<void>;
  validateRoleState(discordId: string, expected: LeagueRoleState): Promise<void>;
  validateDisplayName(discordId: string, expectedDisplayName: string): Promise<void>;
  applyRoleChange(change: DiscordRoleChange, before: LeagueRoleState, after: LeagueRoleState): Promise<void>;
  rollbackRoleChange(change: DiscordRoleChange, expected: LeagueRoleState, applied: LeagueRoleState): Promise<void>;
  findAnnouncement(reference: string): Promise<string | undefined>;
  announce(announcement: LeagueAnnouncement, reference: string): Promise<string>;
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
  expectedPlanFingerprint?: string;
};

export class LeagueTransactionPreviewChangedError extends Error {
  constructor(readonly plan: LeagueMutationPlan) {
    super('League state changed after the transaction preview. Review the updated preview before confirming again.');
  }
}

export function leagueTransactionPlanFingerprint(plan: LeagueMutationPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
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

export class LeagueReconciliationTicketError extends Error {
  readonly leagueReconciliationTicket = true;

  constructor(message: string, readonly reference: string) {
    super(message);
    this.name = 'LeagueReconciliationTicketError';
  }
}

function openReconciliationTicket(
  input: Pick<ExecuteLeagueTransactionInput, 'db' | 'guildId' | 'actorUserId'>,
  auditDate: string,
  error: unknown,
): LeagueReconciliationTicketError {
  const summary = error instanceof Error ? error.message : String(error);
  const fingerprint = createHash('sha256').update(summary).digest('hex');
  const ticket = createOrGetLeagueReconciliationTicket(input.db, {
    reference: `YSL-REC-${auditDate.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    fingerprint,
    summary,
  });
  return new LeagueReconciliationTicketError(
    `Ratatoskr made no changes. Reconcile Discord, Current Rosters, Player Name History, and the public roster, then retry. ${summary}`,
    ticket.reference,
  );
}

function assertDiscordPreconditions(snapshot: LeagueSnapshot, plan: LeagueMutationPlan): void {
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const teamsByRole = new Map(activeTeams.map((team) => [team.teamRoleId, team]));
  for (const discordId of plan.playerIds) {
    const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
    const rosterRows = snapshot.rosters.filter((row) => row.discordId === discordId);
    if (rosterRows.length > 1) throw new Error(`Discord member ${discordId} has multiple roster assignments.`);
    const currentNames = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    if (currentNames.length !== 1) throw new Error(`Discord member ${discordId} must have exactly one current name record.`);
    if (!member) {
      const isDepartedPlayer = plan.kind === 'departure'
        && discordId === plan.playerIds[0]
        && !plan.discordRoleChanges.some((change) => change.discordId === discordId);
      if (isDepartedPlayer && rosterRows.length === 1) {
        continue;
      }
      throw new Error(`Discord member ${discordId} could not be loaded.`);
    }
    const assignedTeamRoles = member.roleIds.filter((roleId) => teamsByRole.has(roleId));
    const roster = rosterRows[0];
    if (roster) {
      const expectedTeam = teamsByRole.get(roster.teamRoleId);
      if (!expectedTeam) throw new Error(`Discord member ${discordId} is rostered to an inactive or unknown team.`);
      const currentName = currentNames[0]!;
      if (currentName.division !== roster.division
        || currentName.franchise !== roster.franchise
        || currentName.leagueStatus !== roster.rosterStatus) {
        throw new Error(`Discord member ${discordId} current-name assignment does not match the current roster.`);
      }
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
      if (currentName.franchise.trim() !== '') {
        throw new Error(`Discord member ${discordId} is a free agent but still has a franchise assignment.`);
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

function expectedRoleState(
  snapshot: LeagueSnapshot,
  rosters: LeagueSnapshot['rosters'],
  names: LeagueSnapshot['names'],
  discordId: string,
): LeagueRoleState {
  const activeTeams = snapshot.teams.filter((team) => team.active);
  const roster = rosters.find((row) => row.discordId === discordId);
  const currentName = names.find((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
  if (!currentName) throw new Error(`Discord member ${discordId} has no current name record.`);
  const team = roster ? activeTeams.find((candidate) => candidate.teamRoleId === roster.teamRoleId) : undefined;
  const divisionRoleId = team?.divisionRoleId
    ?? activeTeams.find((candidate) => candidate.division === currentName.division)?.divisionRoleId;
  if (!divisionRoleId) throw new Error(`Discord member ${discordId} has no configured division role.`);
  return {
    configuredTeamRoleIds: activeTeams.map((candidate) => candidate.teamRoleId),
    expectedTeamRoleId: team?.teamRoleId ?? null,
    configuredDivisionRoleIds: [...new Set(activeTeams.map((candidate) => candidate.divisionRoleId))],
    freeAgentRoleId: snapshot.freeAgentRoleId,
    expectsFreeAgent: !roster && currentName.leagueStatus === 'Free Agent',
    divisionRoleId,
  };
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
  if (plan.kind === 'departure') {
    const replacement = plan.players[1] && plan.playerIds[1]
      ? ` ${mention(team.teamRoleId)} picks up <@${plan.playerIds[1]}> in their place.`
      : '';
    return {
      content: mention(team.teamRoleId),
      allowedRoleIds: [team.teamRoleId],
      title: 'Word Travels the Branches',
      description: `Ratatoskr carries word from ${mention(team.teamRoleId)}.\n\n**${plan.players[0]}** leaves ${mention(team.teamRoleId)} and the YSL server.${replacement}`,
      footer: `Posted by ${actorName}`,
    };
  }
  if (plan.kind === 'self-drop') {
    const replacement = plan.playerIds[1]
      ? ` ${mention(team.teamRoleId)} picks up <@${plan.playerIds[1]}> in their place.`
      : '';
    return {
      content: mention(team.teamRoleId),
      allowedRoleIds: [team.teamRoleId],
      title: 'Word Travels the Branches',
      description: `Ratatoskr carries word from ${mention(team.teamRoleId)}.\n\n<@${plan.playerIds[0]}> self-drops from ${mention(team.teamRoleId)}.${replacement}`,
      footer: `Posted by ${actorName}`,
    };
  }
  if (plan.kind === 'drop' && plan.playerIds[1]) {
    return {
      content: mention(team.teamRoleId),
      allowedRoleIds: [team.teamRoleId],
      title: 'Word Travels the Branches',
      description: `Ratatoskr carries word from ${mention(team.teamRoleId)}.\n\n${mention(team.teamRoleId)} drops <@${plan.playerIds[0]}> into free agency and picks up <@${plan.playerIds[1]}>.`,
      footer: `Posted by ${actorName}`,
    };
  }
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

async function rollbackDiscord(
  discord: LeagueDiscordPort,
  applied: DiscordRoleChange[],
  beforeByPlayer: Map<string, LeagueRoleState>,
  afterByPlayer: Map<string, LeagueRoleState>,
): Promise<void> {
  for (const change of [...applied].reverse()) {
    await discord.rollbackRoleChange(
      change,
      beforeByPlayer.get(change.discordId)!,
      afterByPlayer.get(change.discordId)!,
    );
  }
}

export async function executeLeagueTransaction(input: ExecuteLeagueTransactionInput): Promise<{ reference: string; announcementId?: string }> {
  const release = acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    const members = input.discord.getMembers ? await input.discord.getMembers() : [];
    const auditDate = dateInLeagueTimezone(input.now);
    let loaded: LoadedLeagueSnapshot;
    try {
      loaded = await input.sheets.load(members, input.freeAgentRoleId);
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    const plan = input.buildPlan(loaded.snapshot);
    const issues = humanizeLeagueAuditIssues(
      loaded.snapshot,
      auditLeagueRoster(loaded.snapshot,
        plan.kind === 'departure'
          ? { allowAbsentRosterMemberId: plan.playerIds[0] }
          : plan.kind === 'rename'
            ? { allowDiscordNameRepairMemberId: plan.playerIds[0] }
            : {}),
    );
    if (issues.length) {
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: 'failed', issues });
      throw openReconciliationTicket(
        input,
        auditDate,
        new Error(`League audit failed. ${issues.slice(0, 5).join(' ')}`),
      );
    }
    const auditPassDeferredUntilRename = plan.kind === 'rename';
    if (!auditPassDeferredUntilRename) {
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: 'passed', issues: [] });
    }
    try {
      await input.sheets.assertUnchanged(loaded);
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    if (!auditPassDeferredUntilRename) resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
    if (input.expectedPlanFingerprint
      && leagueTransactionPlanFingerprint(plan) !== input.expectedPlanFingerprint) {
      throw new LeagueTransactionPreviewChangedError(plan);
    }
    assertDiscordPreconditions(loaded.snapshot, plan);
    if (plan.kind === 'departure') await input.discord.validateMemberAbsent(plan.playerIds[0]!);
    let prepared: PreparedLeagueSheetMutation;
    try {
      prepared = input.sheets.prepare(loaded, plan);
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    const roleValidationPlayerIds = plan.kind === 'departure' ? plan.playerIds.slice(1) : plan.playerIds;
    const beforeByPlayer = new Map(roleValidationPlayerIds.map((discordId) => [
      discordId,
      expectedRoleState(loaded.snapshot, loaded.snapshot.rosters, loaded.snapshot.names, discordId),
    ]));
    const afterByPlayer = new Map(roleValidationPlayerIds.map((discordId) => [
      discordId,
      expectedRoleState(loaded.snapshot, plan.rosters, plan.nameUpdates, discordId),
    ]));
    try {
      for (const discordId of roleValidationPlayerIds) {
        await input.discord.validateRoleState(discordId, beforeByPlayer.get(discordId)!);
      }
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    if (plan.kind === 'rename') {
      await input.discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
    }

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
        await input.discord.applyRoleChange(change, beforeByPlayer.get(change.discordId)!, afterByPlayer.get(change.discordId)!);
        applied.push(change);
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'reconciliationRequired' in error && error.reconciliationRequired === true) {
        markLeagueTransactionReconciliationRequired(input.db, reference, error instanceof Error ? error.message : String(error));
        throw errorWithReference(error, reference);
      }
      try {
        await rollbackDiscord(input.discord, applied, beforeByPlayer, afterByPlayer);
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
          await rollbackDiscord(input.discord, applied, beforeByPlayer, afterByPlayer);
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
    if (auditPassDeferredUntilRename) {
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: 'passed', issues: [] });
      resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
    }

    transitionLeagueTransaction(input.db, reference, 'applying_sheets', 'announcement_pending');
    const announcement = buildLeagueAnnouncement(plan, input.actorName);
    let announcementId: string | undefined;
    if (announcement) {
      try {
        announcementId = await input.discord.announce(announcement, reference);
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
  reportError?(reference: string, error: unknown): Promise<{ staffDelivered: boolean }>;
}): Promise<void> {
  for (const repair of listIncompleteLeagueAuditRepairs(input.db)) {
    const message = repair.errorMessage
      ?? 'League audit repair was interrupted. Discord roles or managed roster sheets may be partially applied; manual reconciliation is required.';
    if (repair.status === 'applying') {
      markLeagueAuditRepairReconciliationRequired(input.db, repair.reference, message);
    }
    if (!getLeagueReconciliationTicket(input.db, repair.reference)) {
      createOrGetLeagueReconciliationTicket(input.db, {
        reference: repair.reference,
        guildId: repair.guildId,
        actorUserId: repair.actorUserId,
        fingerprint: `audit-repair:${repair.reference}`,
        summary: `${repair.finding} ${message}`,
      });
    }
  }

  for (const ticket of listUndeliveredLeagueReconciliationTickets(input.db)) {
    const error = new LeagueReconciliationTicketError(
      `Ratatoskr made no changes. Reconcile Discord, Current Rosters, Player Name History, and the public roster, then retry. ${ticket.summary}`,
      ticket.reference,
    );
    const report = await input.reportError?.(ticket.reference, error);
    if (report?.staffDelivered) markLeagueReconciliationTicketAlerted(input.db, ticket.reference);
  }

  for (const transaction of listInterruptedLeagueTransactions(input.db)) {
    const error = new Error(transaction.errorMessage
      ?? `League transaction was interrupted during ${transaction.status}. Discord roles and Google Sheets may be partially applied; manual reconciliation is required.`);
    if (transaction.status !== 'reconciliation_required') {
      markLeagueTransactionReconciliationRequired(input.db, transaction.reference, error.message);
    }
    console.error(`League transaction ${transaction.reference} requires reconciliation after restart`, error);
    const report = await input.reportError?.(transaction.reference, error);
    if (report?.staffDelivered) markLeagueTransactionReconciliationAlerted(input.db, transaction.reference);
  }

  for (const transaction of listPendingLeagueAnnouncements(input.db)) {
    try {
      const { plan, record } = pendingPayload(transaction.payload);
      let announcementId = transaction.announcementId ?? undefined;
      const announcement = buildLeagueAnnouncement(plan, record.processedBy);
      if (announcement && !announcementId) {
        announcementId = await input.discord.findAnnouncement(transaction.reference)
          ?? await input.discord.announce(announcement, transaction.reference);
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
