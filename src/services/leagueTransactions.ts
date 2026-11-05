import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assertNoUnresolvedAccountReplacement } from '../db/repositories/leagueAccountReplacements.js';
import { isLayeredDivision, layeredRoster, primaryRoster, isOneWayTrade, reinstatementPolicyExceptions, auditLeagueRoster, LeagueMutationValidationError, type DiscordNicknameChange, type DiscordRoleChange, type LeagueMutationPlan, type LeagueSnapshot, type LeagueTeam } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import {
  createLeagueTransaction,
  getLeagueTransaction,
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
  LeagueSheetInputError,
  LeagueSheetReconciliationRequiredError,
  type LeagueTransactionRecord,
  type LoadedLeagueSnapshot,
  type PreparedLeagueSheetMutation,
  type DraftPickMove,
  draftPickLabel,
} from './leagueSheets.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import type { LeagueMemberReadOptions } from './leagueMemberReads.js';
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
  observedManagedRoleIds?: string[];
  // A layered membership's roles (Niflheim, #198). Absent while no layered division
  // is active, so the state above is unchanged for everyone else.
  layered?: { configuredTeamRoleIds: string[]; expectedTeamRoleId: string | null; divisionRoleId: string };
};

// ponytail: one layered division (Niflheim); make this a list if a second one appears.
export function layeredRoleState(
  activeTeams: LeagueTeam[], rosters: LeagueSnapshot['rosters'], discordId: string,
): LeagueRoleState['layered'] {
  const teams = activeTeams.filter((team) => isLayeredDivision(team.division));
  if (!teams.length) return undefined;
  const row = layeredRoster(rosters, discordId);
  return {
    configuredTeamRoleIds: teams.map((team) => team.teamRoleId),
    expectedTeamRoleId: row ? teams.find((team) => team.teamRoleId === row.teamRoleId)?.teamRoleId ?? null : null,
    divisionRoleId: teams[0]!.divisionRoleId,
  };
}

export function managedRoleIds(state: LeagueRoleState): Set<string> {
  return new Set([...state.configuredTeamRoleIds, ...state.configuredDivisionRoleIds, state.freeAgentRoleId,
    ...(state.layered ? [...state.layered.configuredTeamRoleIds, state.layered.divisionRoleId] : [])]);
}

export interface LeagueSheetsPort {
  load(discordMembers: LeagueSnapshot['discordMembers'], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot>;
  assertUnchanged(loaded: LoadedLeagueSnapshot): Promise<void>;
  assertOneWayTradeDestination?(prepared: PreparedLeagueSheetMutation): Promise<void>;
  prepare(loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan): PreparedLeagueSheetMutation;
  apply(
    loaded: LoadedLeagueSnapshot,
    plan: LeagueMutationPlan,
    record: LeagueTransactionRecord,
    prepared: PreparedLeagueSheetMutation,
  ): Promise<void>;
  appendTransactionHistory(plan: LeagueMutationPlan, record: LeagueTransactionRecord): Promise<DraftPickMove[] | void>;
}

export interface LeagueDiscordPort {
  validateOneWayTradeRoles?(plan: LeagueMutationPlan): Promise<void>;
  validateReinstatementRoles?(plan: LeagueMutationPlan, snapshot: LeagueSnapshot): Promise<void>;
  getMembers?(options?: LeagueMemberReadOptions): Promise<LeagueSnapshot['discordMembers']>;
  validateMemberAbsent(discordId: string, presentRemedy?: 'drop' | 'self-drop'): Promise<void>;
  validateRoleState(discordId: string, expected: LeagueRoleState): Promise<void>;
  validateDisplayName(discordId: string, expectedDisplayName: string): Promise<void>;
  validateNicknameChange?(change: DiscordNicknameChange): Promise<void>;
  applyNicknameChange?(change: DiscordNicknameChange): Promise<void>;
  verifyNicknameChange?(change: DiscordNicknameChange): Promise<void>;
  rollbackNicknameChange?(change: DiscordNicknameChange): Promise<void>;
  applyRoleChange(change: DiscordRoleChange, before: LeagueRoleState, after: LeagueRoleState): Promise<void>;
  rollbackRoleChange(change: DiscordRoleChange, expected: LeagueRoleState, applied: LeagueRoleState): Promise<void>;
  findAnnouncement(reference: string): Promise<string | undefined>;
  notifyStaff?(content: string): Promise<void>;
  announce(announcement: LeagueAnnouncement, reference: string): Promise<string>;
}

type ExecuteLeagueTransactionInput = {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  actorUserId: string;
  actorName: string;
  approvedAt?: string;
  freeAgentRoleId: string;
  now: Date;
  sheets: LeagueSheetsPort;
  discord: LeagueDiscordPort;
  buildPlan(snapshot: LeagueSnapshot, loaded: LoadedLeagueSnapshot): LeagueMutationPlan | Promise<LeagueMutationPlan>;
  authorizeBeforeWrite?(): Promise<void>;
  expectedPlanFingerprint?: string;
  jobReference?: string;
  onPhase?(phase: 'VALIDATING' | 'APPLYING' | 'VERIFYING'): void;
};

export class LeagueTransactionPreviewChangedError extends Error {
  constructor(readonly plan: LeagueMutationPlan) {
    super('League state changed after the transaction preview. Review the updated preview before confirming again.');
  }
}

export async function validateOneWayTradePreview(
  loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan,
  sheets: Pick<LeagueSheetsPort, 'prepare' | 'assertOneWayTradeDestination'>,
  discord: Pick<LeagueDiscordPort, 'validateOneWayTradeRoles' | 'validateDisplayName'>,
): Promise<void> {
  const issues = auditLeagueRoster(loaded.snapshot);
  if (issues.length) {
    console.error('One-way trade preview roster audit failed:', issues);
    throw new LeagueMutationValidationError(humanizeLeagueAuditIssues(loaded.snapshot, issues).slice(0, 3).join(' '));
  }
  try {
    if (!sheets.assertOneWayTradeDestination || !discord.validateOneWayTradeRoles) throw new Error('Trade checks unavailable.');
    await sheets.assertOneWayTradeDestination(sheets.prepare(loaded, plan));
    await discord.validateOneWayTradeRoles(plan);
    await discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
  } catch (error) {
    if (error instanceof LeagueMutationValidationError) throw error;
    if (error instanceof LeagueSheetDriftError) throw new LeagueMutationValidationError(error.message);
    console.error('One-way trade preview verification failed:', error);
    throw new LeagueMutationValidationError('Rat could not verify the receiving roster or Discord roles. Check the roster and Rat’s permissions, then preview again.');
  }
}

export function leagueTransactionPlanFingerprint(plan: LeagueMutationPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function dateInLeagueTimezone(now: Date): string {
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
  readonly operationalCode?: string;
  readonly operationalSummary?: string;
  readonly operationalNext?: string;
  readonly operationalNoChanges?: true;

  constructor(message: string, readonly reference: string, cause?: unknown) {
    super(message);
    this.name = 'LeagueReconciliationTicketError';
    if (cause instanceof LeagueSheetInputError) {
      this.operationalCode = cause.operationalCode;
      this.operationalSummary = cause.operationalSummary;
      this.operationalNext = cause.operationalNext;
      this.operationalNoChanges = true;
    }
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
    error,
  );
}

function assertDiscordPreconditions(snapshot: LeagueSnapshot, plan: LeagueMutationPlan): void {
  // Primary memberships only; layered (Niflheim) roles are verified by the role state.
  const activeTeams = snapshot.teams.filter((team) => team.active && !isLayeredDivision(team.division));
  const teamsByRole = new Map(activeTeams.map((team) => [team.teamRoleId, team]));
  for (const discordId of plan.playerIds) {
    const member = snapshot.discordMembers.find((candidate) => candidate.discordId === discordId);
    const rosterRows = snapshot.rosters.filter((row) => row.discordId === discordId && !isLayeredDivision(row.division));
    if (rosterRows.length > 1) throw new Error(`Discord member ${discordId} has multiple roster assignments.`);
    const currentNames = snapshot.names.filter((row) => row.discordId === discordId && row.nameStatus === 'Current Discord Name');
    if (currentNames.length !== 1) throw new Error(`Discord member ${discordId} must have exactly one current name record.`);
    if (!member) {
      const isAbsentExitPlayer = (plan.kind === 'departure' || plan.kind === 'self-drop')
        && discordId === plan.playerIds[0]
        && !plan.discordRoleChanges.some((change) => change.discordId === discordId);
      if (isAbsentExitPlayer && (rosterRows.length === 1 || layeredRoster(snapshot.rosters, discordId))) {
        continue;
      }
      throw new Error(`Discord member ${discordId} could not be loaded.`);
    }
    const assignedTeamRoles = member.roleIds.filter((roleId) => teamsByRole.has(roleId));
    const roster = rosterRows[0];
    if (plan.kind === 'reinstatement') {
      if (roster || assignedTeamRoles.length) throw new LeagueMutationValidationError('The player already has a roster or team role. Reconcile the current assignment first.');
      continue;
    }
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
  const allActive = snapshot.teams.filter((team) => team.active);
  const activeTeams = allActive.filter((team) => !isLayeredDivision(team.division));
  const roster = primaryRoster(rosters, discordId);
  const layered = layeredRoleState(allActive, rosters, discordId);
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
    ...(layered ? { layered } : {}),
  };
}

export function buildLeagueAnnouncement(plan: LeagueMutationPlan, actorName: string, effectiveDate?: string): LeagueAnnouncement | undefined {
  const mention = (roleId: string) => `<@&${roleId}>`;
  // Embed user mentions only resolve for members the viewer's client has cached (mobile often has not).
  // Mentioning present players in content ships their user objects with the message (no ping:
  // allowedMentions only lists roles), and the bold league name keeps a readable label regardless.
  const present = new Set(plan.discordRoleChanges.map((change) => change.discordId));
  const player = (index: number) => present.has(plan.playerIds[index]!)
    ? `**${plan.players[index]}** (<@${plan.playerIds[index]}>)`
    : `**${plan.players[index]}**`;
  const content = (roleIds: string[]) => [
    ...roleIds.map(mention),
    ...plan.playerIds.filter((id) => present.has(id)).map((id) => `<@${id}>`),
  ].join(' ');
  if (plan.kind === 'rename') return undefined;
  if (plan.kind === 'trade') {
    const [firstTeam, secondTeam] = plan.teams;
    return {
      content: content([firstTeam!.teamRoleId, secondTeam!.teamRoleId]),
      allowedRoleIds: [firstTeam!.teamRoleId, secondTeam!.teamRoleId],
      title: 'Word Travels the Branches',
      description: [
        `Ratatoskr carries news of an agreement between ${mention(firstTeam!.teamRoleId)} and ${mention(secondTeam!.teamRoleId)}.`,
        '',
        `${player(0)} leaves ${mention(firstTeam!.teamRoleId)} to join ${mention(secondTeam!.teamRoleId)}.`,
        isOneWayTrade(plan)
          ? 'This is a one-way transfer. No player moves in return.'
          : `${player(1)} leaves ${mention(secondTeam!.teamRoleId)} to join ${mention(firstTeam!.teamRoleId)}.`,
      ].join('\n'),
      footer: `Posted by ${actorName}`,
    };
  }
  const team = plan.teams[0]!;
  // Departure and self-drop can end a Svartalfheim and a Niflheim membership together (#200).
  const allTeams = plan.teams.map((entry) => mention(entry.teamRoleId)).join(' and ');
  const replacement = plan.playerIds[1]
    ? ` ${mention(team.teamRoleId)} picks up ${player(1)} in their place.`
    : '';
  let line: string;
  if (plan.kind === 'reinstatement') line = `${player(0)} returns to ${mention(team.teamRoleId)}.\n\nOfficial league date: ${effectiveDate ?? plan.reinstatement!.selection.effectiveDate}.`;
  else if (plan.kind === 'departure') line = `${player(0)} leaves ${allTeams} and the YSL server.${replacement}`;
  else if (plan.kind === 'self-drop') line = `${player(0)} self-drops from ${allTeams}.${replacement}`;
  else if (plan.kind === 'drop' && isLayeredDivision(team.division)) line = `${player(0)} leaves ${mention(team.teamRoleId)}.${replacement}`;
  else if (plan.kind === 'drop' && plan.playerIds[1]) {
    line = `${mention(team.teamRoleId)} drops ${player(0)} into free agency and picks up ${player(1)}.`;
  } else if (plan.kind === 'drop') line = `${player(0)} leaves ${mention(team.teamRoleId)} and enters free agency.`;
  // A Niflheim pickup comes from the Svartalfheim pool and the player stays a free agent there.
  else if (isLayeredDivision(team.division)) line = `${player(0)} joins ${mention(team.teamRoleId)}.`;
  else line = `${player(0)} leaves free agency to join ${mention(team.teamRoleId)}.`;
  const teamRoleIds = plan.teams.map((entry) => entry.teamRoleId);
  return {
    content: content(teamRoleIds),
    allowedRoleIds: teamRoleIds,
    title: 'Word Travels the Branches',
    description: `Ratatoskr carries word from ${mention(team.teamRoleId)}.\n\n${line}`,
    footer: `Posted by ${actorName}`,
  };
}

// ponytail: best-effort, no durable retry; the Transaction History column M / yellow row is the record.
async function notifyDraftPickMoves(
  discord: LeagueDiscordPort, plan: LeagueMutationPlan, reference: string, moves: DraftPickMove[] | void,
): Promise<void> {
  if (!moves?.length || !discord.notifyStaff) return;
  const lines = moves.map((move) => `**${move.player}** (${draftPickLabel(move)})`);
  try {
    await discord.notifyStaff([`Top-4 draft pick moved (${plan.kind} · ${reference}):`, ...lines].join('\n'));
  } catch (error) {
    console.error(`Top-4 draft pick staff note failed for ${reference}`, error);
  }
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
  const release = await acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    if (input.jobReference) {
      const previous = getLeagueTransaction(input.db, input.jobReference);
      if (previous) {
        if (previous.guildId === input.guildId && previous.status === 'completed')
          return { reference: previous.reference, announcementId: previous.announcementId ?? undefined };
        throw errorWithReference(new Error('This saved action already started. Inspect its recovery status; do not replay it.'), input.jobReference);
      }
    }
    assertNoUnresolvedAccountReplacement(input.db, input.guildId);
    const members = input.discord.getMembers ? await input.discord.getMembers() : [];
    const auditDate = dateInLeagueTimezone(input.now);
    let loaded: LoadedLeagueSnapshot;
    try {
      loaded = await input.sheets.load(members, input.freeAgentRoleId);
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    input.onPhase?.('VALIDATING');
    const plan = await input.buildPlan(loaded.snapshot, loaded);
    if (plan.reinstatement) {
      const details = plan.reinstatement;
      if (details.blockers.length) throw new LeagueMutationValidationError(details.blockers.join(' '));
      if (details.selection.effectiveDate !== auditDate) throw new LeagueMutationValidationError('The league date changed after preview. Review a new reinstatement preview before approving.');
      if (reinstatementPolicyExceptions(details).some(item => !details.selection.overrides.includes(item.id))
        || details.selection.overrides.some(id => id !== 'timing' && !reinstatementPolicyExceptions(details).some(item => item.id === id)))
        throw new LeagueMutationValidationError('Choose each listed staff advisory you approve, then confirm the reviewed exceptions.');
    }
    if (input.expectedPlanFingerprint && leagueTransactionPlanFingerprint(plan) !== input.expectedPlanFingerprint) {
      throw new LeagueTransactionPreviewChangedError(plan);
    }
    const outgoingPlayerIsAbsent = (plan.kind === 'departure' || plan.kind === 'self-drop')
      && !plan.discordRoleChanges.some((change) => change.discordId === plan.playerIds[0]);
    const issues = humanizeLeagueAuditIssues(
      loaded.snapshot,
      auditLeagueRoster(loaded.snapshot,
        plan.kind === 'reinstatement' ? { allowReinstatementMemberId: plan.playerIds[0] }
          : plan.kind === 'departure' || plan.kind === 'self-drop'
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
    const auditPassDeferredUntilMutation = plan.kind === 'rename' || plan.kind === 'reinstatement' || outgoingPlayerIsAbsent;
    if (!auditPassDeferredUntilMutation) {
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: 'passed', issues: [] });
    }
    try {
      await input.sheets.assertUnchanged(loaded);
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    if (!auditPassDeferredUntilMutation) resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
    if (input.expectedPlanFingerprint
      && leagueTransactionPlanFingerprint(plan) !== input.expectedPlanFingerprint) {
      throw new LeagueTransactionPreviewChangedError(plan);
    }
    assertDiscordPreconditions(loaded.snapshot, plan);
    let prepared: PreparedLeagueSheetMutation;
    try {
      prepared = input.sheets.prepare(loaded, plan);
      if (isOneWayTrade(plan)) {
        if (!input.sheets.assertOneWayTradeDestination) throw new Error('Destination verification is unavailable.');
        await input.sheets.assertOneWayTradeDestination(prepared);
      }
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    const roleValidationPlayerIds = plan.playerIds.filter((discordId) =>
      !(outgoingPlayerIsAbsent && discordId === plan.playerIds[0]));
    const beforeByPlayer = new Map(roleValidationPlayerIds.map((discordId) => [
      discordId,
      expectedRoleState(loaded.snapshot, loaded.snapshot.rosters, loaded.snapshot.names, discordId),
    ]));
    if (plan.reinstatement) beforeByPlayer.get(plan.playerIds[0]!)!.observedManagedRoleIds = plan.reinstatement.beforeManagedRoleIds;
    const afterByPlayer = new Map(roleValidationPlayerIds.map((discordId) => [
      discordId,
      expectedRoleState(loaded.snapshot, plan.rosters, plan.nameUpdates, discordId),
    ]));
    // A transfer pins the exact managed roles so its two writes use singular, cache-safe role
    // deltas. A Niflheim transfer leaves the primary roles as they are (its own roles are
    // checked by `layered`), so it pins the primary roles the player holds now (#200).
    if (isOneWayTrade(plan) && isLayeredDivision(plan.teams[0]!.division)) {
      const change = plan.discordRoleChanges[0]!;
      const before = beforeByPlayer.get(change.discordId)!;
      const primaryManaged = new Set([...before.configuredTeamRoleIds, ...before.configuredDivisionRoleIds, before.freeAgentRoleId]);
      const held = (loaded.snapshot.discordMembers.find((member) => member.discordId === change.discordId)?.roleIds ?? [])
        .filter((roleId) => primaryManaged.has(roleId));
      before.observedManagedRoleIds = held;
      afterByPlayer.get(change.discordId)!.observedManagedRoleIds = [...held];
    } else if (isOneWayTrade(plan)) {
      const change = plan.discordRoleChanges[0]!;
      const before = beforeByPlayer.get(change.discordId)!;
      const after = afterByPlayer.get(change.discordId)!;
      before.observedManagedRoleIds = [change.remove[0]!, before.divisionRoleId];
      after.observedManagedRoleIds = [change.add[0]!, after.divisionRoleId];
    }
    try {
      for (const discordId of roleValidationPlayerIds) {
        await input.discord.validateRoleState(discordId, beforeByPlayer.get(discordId)!);
      }
    } catch (error) {
      throw openReconciliationTicket(input, auditDate, error);
    }
    if (plan.reinstatement) {
      if (!input.discord.validateReinstatementRoles) throw new LeagueMutationValidationError('Managed role verification is unavailable. Ask staff to check the bot.');
      await input.discord.validateReinstatementRoles(plan, loaded.snapshot);
      // A planned nickname restore is checked against the exact approved before-state below.
      if (!plan.discordNicknameChange) await input.discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
      await input.authorizeBeforeWrite?.();
      const freshPlan = await input.buildPlan(loaded.snapshot, loaded);
      if (leagueTransactionPlanFingerprint(freshPlan) !== leagueTransactionPlanFingerprint(plan))
        throw new LeagueTransactionPreviewChangedError(freshPlan);
    }
    if (isOneWayTrade(plan)) {
      if (!input.discord.validateOneWayTradeRoles) throw new LeagueMutationValidationError('Discord role verification is unavailable.');
      await input.discord.validateOneWayTradeRoles(plan);
      await input.discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
      await input.authorizeBeforeWrite?.();
    }
    const nickname = plan.discordNicknameChange;
    if (nickname) {
      if ((plan.kind !== 'rename' && plan.kind !== 'reinstatement') || !input.discord.validateNicknameChange || !input.discord.applyNicknameChange
        || !input.discord.verifyNicknameChange || !input.discord.rollbackNicknameChange)
        throw new LeagueMutationValidationError('The approved nickname change cannot be executed safely. No changes were made.');
      await input.discord.validateNicknameChange(nickname);
    } else if (plan.kind === 'rename') {
      await input.discord.validateDisplayName(plan.playerIds[0]!, plan.players[0]!);
    }
    if (outgoingPlayerIsAbsent) {
      await input.discord.validateMemberAbsent(
        plan.playerIds[0]!,
        plan.kind === 'self-drop' ? 'self-drop' : 'drop',
      );
    }

    const reference = input.jobReference ?? `YSL-TRX-${auditDate.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const record: LeagueTransactionRecord = {
      reference, effectiveDate: plan.reinstatement?.selection.effectiveDate ?? auditDate, processedById: input.actorUserId, processedBy: input.actorName,
      ...(plan.reinstatement ? { approvedAt: input.approvedAt, processedAt: input.now.toISOString(), approvalNote: `Reinstates ${plan.reinstatement.source.reference}; approved by ${input.actorUserId}; future sanction preserved` } : {}),
    };
    createLeagueTransaction(input.db, {
      reference, guildId: input.guildId, kind: plan.kind, actorUserId: input.actorUserId,
      payload: { plan, record },
    });

    input.onPhase?.('APPLYING');
    const applied: DiscordRoleChange[] = [];
    let nicknameApplied = false;
    const rollback = async () => {
      await rollbackDiscord(input.discord, applied, beforeByPlayer, afterByPlayer);
      if (nicknameApplied) await input.discord.rollbackNicknameChange!(nickname!);
    };
    try {
      if (nickname) {
        await input.discord.applyNicknameChange!(nickname);
        nicknameApplied = true;
      }
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
        await rollback();
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
          await rollback();
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
    if (nickname) {
      try { await input.discord.verifyNicknameChange!(nickname); }
      catch (error) {
        markLeagueTransactionReconciliationRequired(input.db, reference, `Nickname verification failed after Sheets write: ${String(error)}`);
        throw errorWithReference(error, reference);
      }
    }
    if (auditPassDeferredUntilMutation) {
      recordLeagueAudit(input.db, { guildId: input.guildId, auditDate, status: 'passed', issues: [] });
      resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
    }

    input.onPhase?.('VERIFYING');
    transitionLeagueTransaction(input.db, reference, 'applying_sheets', 'announcement_pending');
    const announcement = buildLeagueAnnouncement(plan, input.actorName, record.effectiveDate);
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
      await notifyDraftPickMoves(input.discord, plan, reference, await input.sheets.appendTransactionHistory(plan, record));
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
      const announcement = buildLeagueAnnouncement(plan, record.processedBy, record.effectiveDate);
      if (announcement && !announcementId) {
        announcementId = await input.discord.findAnnouncement(transaction.reference)
          ?? await input.discord.announce(announcement, transaction.reference);
        record.announcementId = announcementId;
        transitionLeagueTransaction(input.db, transaction.reference, 'announcement_pending', 'announcement_pending', { announcementId });
      } else if (announcementId) record.announcementId = announcementId;
      await notifyDraftPickMoves(input.discord, plan, transaction.reference, await input.sheets.appendTransactionHistory(plan, record));
      transitionLeagueTransaction(input.db, transaction.reference, 'announcement_pending', 'completed', { announcementId });
    } catch (error) {
      console.error(`League transaction recovery remains pending for ${transaction.reference}`, error);
      await input.reportError?.(transaction.reference, error);
    }
  }
}
