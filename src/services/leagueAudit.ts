import { listLeagueFindings, replaceFullLeagueFindings } from '../db/repositories/leagueVerifiedState.js';
import { listActionableLeagueJobs, dismissResolvedRepairReviews } from '../db/repositories/leagueJobs.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type LeagueSnapshot } from '../domain/leagueOperations.js';
import {
  beginDirtyLeagueAudit,
  confirmLeagueAuditCard,
  getLeagueAuditState,
  markLeagueAuditSendAttempted,
  setLeagueAuditNextRunAt,
  settleLeagueAuditCard,
  type PersistedLeagueOpsCard,
  noteLeagueCheck,
  noteCleanFullLeagueAudit,
  noteLeaguePanelRepost,
  recordLeaguePanelEdit,
} from '../db/repositories/leagueAudits.js';
import {
  recordLeagueAudit,
  resolveOpenLeagueReconciliationTickets,
  listOpenLeagueReconciliationTickets,
  listLeagueMutationProblems,
  listResolvedLeagueAlertReferences,
  markLeagueAlertCleaned,
  getLegacyLeagueAlertCleanupCutoff,
  wasLeagueAlertCleaned,
} from '../db/repositories/leagueOperations.js';
import { LeagueSheetInputError, type LoadedLeagueSnapshot } from './leagueSheets.js';
import { runCoalescedLeagueAudit } from './leagueOperationCoordinator.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { listIncompleteLeagueAuditRepairs } from '../db/repositories/leagueAuditRepairs.js';

export type LeagueAuditCard = PersistedLeagueOpsCard;

export interface LeagueAuditCardPort {
  deleteResolvedAlerts?(references: string[]): Promise<void>;
  deleteLegacyResolvedAlerts?(verifiedBefore: string, previouslyScannedBefore?: string): Promise<void>;
  findByReference(reference: string): Promise<string | undefined>;
  send(card: LeagueAuditCard, reference: string): Promise<string>;
  delete(messageId: string): Promise<void>;
  edit?(messageId: string, card: LeagueAuditCard, reference: string): Promise<void>;
}

type Input = {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  trigger: 'startup' | 'scheduled';
  now: Date;
  freeAgentRoleId: string;
  members: { getMembers(): Promise<LeagueSnapshot['discordMembers']> };
  sheets: { load(members: LeagueSnapshot['discordMembers'], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot> };
  cards: LeagueAuditCardPort;
  freshAfterRecovery?: boolean;
};

const LEAGUE_TIMEZONE = 'America/New_York';

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function localTimeToUtc(parts: ZonedParts): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedParts(new Date(guess));
    const observedValue = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const difference = target - observedValue;
    if (difference === 0) break;
    guess += difference;
  }
  return new Date(guess);
}

export function nextLeagueAuditAt(now: Date): Date {
  const current = zonedParts(now);
  const localDay = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const beforeSix = current.hour < 6;
  if (!beforeSix) localDay.setUTCDate(localDay.getUTCDate() + 1);
  return localTimeToUtc({
    year: localDay.getUTCFullYear(),
    month: localDay.getUTCMonth() + 1,
    day: localDay.getUTCDate(),
    hour: 6,
    minute: 0,
    second: 0,
  });
}

function auditDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function cardFor(
  result: 'clean' | 'dirty' | 'error',
  issues: string[],
  now: Date,
  trigger: Input['trigger'],
): LeagueAuditCard {
  const intro =
    result === 'error'
      ? issues.length
        ? 'The latest check could not finish. The findings below are from the last verified reads and may have changed. Review remains available; every confirmed repair must read fresh state before writing.'
        : 'The latest check could not finish. No verified player findings are available to review. No changes were made by this check.'
      : issues.length
        ? `Ratatoskr found ${issues.length} item${issues.length === 1 ? ' that needs' : 's that need'} a league admin to review. Nothing was changed automatically.`
        : 'An operation needs administrator review before it can proceed safely.';
  const categories = [
    [
      'Player names',
      issues.filter(
        (issue) =>
          (issue.includes('Discord name now:') &&
            issue.includes('Current Rosters sheet:') &&
            issue.includes('Player Name History sheet:')) ||
          (issue.includes('Current Rosters:') &&
            issue.includes('Player Name History:') &&
            issue.includes('Make the names match.')),
      ).length,
    ],
    [
      'Departures or inactive players',
      issues.filter((issue) => issue.includes('no longer in the Discord server')).length,
    ],
    [
      'Discord roles',
      issues.filter(
        (issue) =>
          !issue.includes('no longer in the Discord server') &&
          /Discord .*role|role in Discord|Discord division|Discord team/i.test(issue),
      ).length,
    ],
    ['Roster sheets and setup', 0],
  ] as Array<[string, number]>;
  if (categories.length)
    categories[3]![1] = issues.length - categories.slice(0, 3).reduce((sum, entry) => sum + entry[1], 0);
  const summary = categories
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `• ${label}: ${count}`)
    .join('\n');
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  return {
    title: 'League Ops Status',
    description:
      result === 'clean'
        ? 'Status: Healthy\nOpen reconciliation items: 0'
        : `Status: Attention required\nOpen reconciliation items: ${issues.length}\n\n${intro}${summary ? `\n\n${summary}\n\nSelect **Review issues** for a private, step-by-step queue.` : ''}`,
    footer: `${trigger === 'startup' ? 'Startup' : 'Daily'} audit • ${time}`,
    allowedMentions: false,
    ...(issues.length ? { actions: [{ id: 'league-audit:review', label: 'Review issues' }] } : {}),
  };
}

export async function recoverPendingLeagueAudit(input: Pick<Input, 'db' | 'guildId' | 'cards'>): Promise<boolean> {
  let state = getLeagueAuditState(input.db, input.guildId);
  if (!state || state.phase === 'settled') return false;
  if (state.phase === 'send_pending') {
    let messageId = state.sendAttempted ? await input.cards.findByReference(state.runReference) : undefined;
    if (!messageId) {
      markLeagueAuditSendAttempted(input.db, input.guildId, state.runReference);
      const card = state.pendingCard ?? cardFor(state.result, state.findings, new Date(state.runAt), state.trigger);
      if (!state.pendingCard)
        card.description += `\n\nLast targeted check: ${state.lastTargetedAt ?? 'Pending'}\nLast full audit: ${state.lastFullAt ?? 'Pending'}`;
      messageId = await input.cards.send(card, state.runReference);
    }
    confirmLeagueAuditCard(input.db, input.guildId, state.runReference, messageId);
    state = getLeagueAuditState(input.db, input.guildId)!;
  }
  if (state.phase === 'delete_pending') {
    if (state.staleMessageId) await input.cards.delete(state.staleMessageId);
    settleLeagueAuditCard(input.db, input.guildId, state.runReference);
  }
  return true;
}

export async function refreshLeagueOpsPanel(
  input: Pick<Input, 'db' | 'guildId' | 'cards'> & { now: Date; repost?: boolean; repostQueuedAt?: string },
): Promise<string | undefined> {
  const recovered = await recoverPendingLeagueAudit(input);
  // Recovery already completed the pending replacement. Refresh its content,
  // but never start a second replacement during the same heartbeat retry.
  if (recovered && input.repost) noteLeaguePanelRepost(input.db, input.guildId, input.now);
  if (recovered && !input.cards.edit)
    return getLeagueAuditState(input.db, input.guildId)?.currentMessageId ?? undefined;
  const cleanupResolvedAlerts = async () => {
    const resolvedAlerts = listResolvedLeagueAlertReferences(input.db, input.guildId);
    if (resolvedAlerts.length && input.cards.deleteResolvedAlerts) {
      await input.cards.deleteResolvedAlerts(resolvedAlerts);
      for (const reference of resolvedAlerts) markLeagueAlertCleaned(input.db, input.guildId, reference);
    }
    const auditState = getLeagueAuditState(input.db, input.guildId);
    const verifiedAt = auditState?.lastCleanFullAt === auditState?.lastFullAt ? auditState?.lastCleanFullAt : undefined;
    if (result === 'clean' && verifiedAt && input.cards.deleteLegacyResolvedAlerts) {
      const checkpoint = `legacy-alerts-before:${verifiedAt}`;
      if (!wasLeagueAlertCleaned(input.db, input.guildId, checkpoint)) {
        await input.cards.deleteLegacyResolvedAlerts(verifiedAt, getLegacyLeagueAlertCleanupCutoff(input.db, input.guildId));
        markLeagueAlertCleaned(input.db, input.guildId, checkpoint);
      }
    }
  };
  const prior = getLeagueAuditState(input.db, input.guildId);
  const alreadyReposted = input.repostQueuedAt && prior?.lastRepostAt
    && Date.parse(prior.lastRepostAt) >= Date.parse(input.repostQueuedAt);
  const resources = listLeagueFindings(input.db, input.guildId);
  const readErrors = resources.filter((entry) => entry.resourceKey === 'connection').flatMap((entry) => entry.findings);
  const issues = [
    ...new Set(resources.filter((entry) => entry.resourceKey !== 'connection').flatMap((entry) => entry.findings)),
  ];
  const tickets = listOpenLeagueReconciliationTickets(input.db, input.guildId);
  for (const ticket of tickets) if (!issues.includes(ticket.summary)) issues.push(ticket.summary);
  const mutationProblems = listLeagueMutationProblems(input.db, input.guildId);
  const recoverableRepairs = listIncompleteLeagueAuditRepairs(input.db)
    .filter((repair) => repair.guildId === input.guildId && repair.status === 'reconciliation_required');
  const repairReferences = new Set(recoverableRepairs.map((repair) => repair.reference));
  const jobs = listActionableLeagueJobs(input.db, input.guildId).filter(
    (job) => !['panel', 'heartbeat'].includes(job.type),
  );
  const errorState = listLeagueFindings(input.db, input.guildId).some((entry) => entry.resourceKey === 'connection');
  const result = errorState ? 'error' : issues.length || jobs.length || mutationProblems.length ? 'dirty' : 'clean';
  const reference = `YSL-AUD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const card = cardFor(result, issues, input.now, 'scheduled');
  if (readErrors.length)
    card.description += `\n\nLatest check: ${readErrors.join('\n')}\nRatatoskr will retry automatically in the dirty-state cycle (2 minutes).`;
  if (result === 'clean' && !prior?.lastFullAt)
    card.description =
      'Status: Checking league state\nOpen reconciliation items: 0\nThe startup safety check is pending.';
  if (!issues.length) card.actions = undefined;
  if (recoverableRepairs.length) card.actions = [...(card.actions ?? []), { id: 'league-recovery:list', label: 'Review operations' }];
  card.actions = [...(card.actions ?? []), { id: 'league-recovery:recheck', label: 'Recheck roster' }];
  if (jobs.length)
    card.description +=
      `\n\nOperations to review: ${jobs.length}\n` +
      jobs
        .slice(-8)
        .map(
          (job) =>
            `${job.reference}: ${job.status === 'BLOCKED_REVIEW' ? 'Review a fresh transaction preview' : job.status === 'RECONCILIATION_REQUIRED' ? (job.result && typeof job.result === 'object' && 'pendingDelivery' in job.result ? 'Roster change complete; public notice/history is being recovered' : 'Check a possibly partial operation before retrying') : 'Check permissions or configuration, then retry'}`,
        )
        .join('\n');
  const additionalProblems = mutationProblems.filter((reference) => !jobs.some((job) => job.reference === reference));
  if (additionalProblems.length) {
    card.description += `\n\nPossibly partial operations: ${additionalProblems.length}`;
    const repairs = additionalProblems.filter((reference) => repairReferences.has(reference));
    const transactions = additionalProblems.filter((reference) => !repairReferences.has(reference));
    if (repairs.length) card.description += `\nSelect Review operations to inspect and reconcile repairs: ${repairs.slice(-5).join(', ')}`;
    if (transactions.length) card.description += `\nInspect Discord, managed sheets and transaction notice/history for: ${transactions.slice(-5).join(', ')}. Do not replay the transaction.`;
  }
  const times = getLeagueAuditState(input.db, input.guildId);
  card.description += `\n\nLast targeted check: ${times?.lastTargetedAt ?? 'Pending'}\nLast full audit: ${times?.lastFullAt ?? 'Pending'}`;
  if (prior?.currentMessageId && (!input.repost || recovered || alreadyReposted) && input.cards.edit) {
    await input.cards.edit(prior.currentMessageId, card, reference);
    recordLeaguePanelEdit(input.db, {
      guildId: input.guildId,
      messageId: prior.currentMessageId,
      result,
      findings: issues,
      reference,
      at: input.now,
      card,
    });
    await cleanupResolvedAlerts();
    return prior.currentMessageId;
  }
  beginDirtyLeagueAudit(input.db, {
    guildId: input.guildId,
    result,
    findings: issues,
    runReference: reference,
    runAt: input.now.toISOString(),
    trigger: 'scheduled',
    card,
  });
  await recoverPendingLeagueAudit(input);
  noteLeaguePanelRepost(input.db, input.guildId, input.now);
  await cleanupResolvedAlerts();
  return getLeagueAuditState(input.db, input.guildId)?.currentMessageId ?? undefined;
}

async function checkLeagueAudit(input: Input): Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[] }> {
  let issues: string[];
  let result: 'clean' | 'dirty' | 'error';
  try {
    const members = await input.members.getMembers();
    const loaded = await input.sheets.load(members, input.freeAgentRoleId);
    const diagnostics = auditLeagueRoster(loaded.snapshot);
    issues = humanizeLeagueAuditIssues(loaded.snapshot, diagnostics);
    result = issues.length ? 'dirty' : 'clean';
    replaceFullLeagueFindings(input.db, input.guildId, loaded.snapshot, diagnostics,
      diagnostics.map((diagnostic) => humanizeLeagueAuditIssues(loaded.snapshot, [diagnostic])[0]!), input.now);
    dismissResolvedRepairReviews(input.db, input.guildId, issues);
  } catch (error) {
    console.error('League roster audit could not read every source:', error);
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    issues =
      error instanceof LeagueSheetInputError
        ? [
            `**What happened:** ${error.operationalSummary}`,
            `**What to do:** ${error.operationalNext}`,
            `**Error code:** ${error.operationalCode}`,
          ]
        : status === 429
          ? [
              'Google Sheets read quota reached (429). Reads are paused before retrying; no roster changes were made by this check.',
            ]
          : status === 503
            ? ['Google Sheets is temporarily unavailable (503). No roster changes were made by this check.']
            : [
                'The audit could not read every required Discord and roster-sheet source. No roster changes were made by this check.',
              ];
    result = 'error';
    const { replaceLeagueFindings } = await import('../db/repositories/leagueVerifiedState.js');
    replaceLeagueFindings(input.db, input.guildId, 'connection', issues, input.now);
  }
  recordLeagueAudit(input.db, {
    guildId: input.guildId,
    auditDate: auditDate(input.now),
    status: result === 'clean' ? 'passed' : 'failed',
    issues,
  });
  if (result === 'clean') resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
  // Create durable panel state even before the first Discord delivery.
  if (!getLeagueAuditState(input.db, input.guildId)) {
    const initialCard = cardFor(result, result === 'error' ? [] : issues, input.now, input.trigger);
    if (result === 'error')
      initialCard.description += `\n\n${issues.join('\n')}\nNo changes were made by this check. The next dirty-state check will retry automatically.`;
    beginDirtyLeagueAudit(input.db, {
      guildId: input.guildId,
      result,
      findings: issues,
      runReference: `YSL-AUD-${randomUUID().slice(0, 8)}`,
      runAt: input.now.toISOString(),
      trigger: input.trigger,
      card: initialCard,
    });
  }
  if (result !== 'error') noteLeagueCheck(input.db, input.guildId, 'full', input.now);
  if (result === 'clean') noteCleanFullLeagueAudit(input.db, input.guildId, input.now);
  return { status: result, issues };
}

async function runLeagueAuditOnce(
  input: Input & { deferPresentation?: boolean },
): Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[]; cardId?: string }> {
  if (!input.deferPresentation) {
    const recovered = await recoverPendingLeagueAudit(input);
    if (recovered && !input.freshAfterRecovery) {
      const state = getLeagueAuditState(input.db, input.guildId)!;
      return { status: state.result, issues: state.findings, cardId: state.currentMessageId ?? undefined };
    }
  }
  const result = await runCoalescedLeagueAudit(input.operationScope, input.guildId, () => checkLeagueAudit(input));
  if (input.deferPresentation) return result;
  return { ...result, cardId: await refreshLeagueOpsPanel({ ...input, repost: !input.cards.edit }) };
}

const activeAudits = new WeakMap<
  object,
  Map<string, Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[]; cardId?: string }>>
>();
export function runLeagueAudit(
  input: Input & { deferPresentation?: boolean },
): Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[]; cardId?: string }> {
  let guilds = activeAudits.get(input.operationScope);
  if (!guilds) {
    guilds = new Map();
    activeAudits.set(input.operationScope, guilds);
  }
  const active = guilds.get(input.guildId);
  if (active) return active;
  const run = runLeagueAuditOnce(input);
  guilds.set(input.guildId, run);
  void run
    .finally(() => {
      if (guilds!.get(input.guildId) === run) guilds!.delete(input.guildId);
    })
    .catch(() => undefined);
  return run;
}

type TimerHandle = { unref?(): unknown };

export function startLeagueAuditWorker(input: {
  db: Database.Database;
  guildId: string;
  run(): Promise<void>;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): () => void {
  const now = input.now ?? (() => new Date());
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let timer: TimerHandle | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const current = now();
    const next = nextLeagueAuditAt(current);
    setLeagueAuditNextRunAt(input.db, input.guildId, next.toISOString());
    timer = setTimer(
      () => {
        void input
          .run()
          .catch((error) => console.error('Daily league roster audit failed:', error))
          .finally(schedule);
      },
      Math.max(0, next.getTime() - current.getTime()),
    );
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    setLeagueAuditNextRunAt(input.db, input.guildId, null);
  };
}
