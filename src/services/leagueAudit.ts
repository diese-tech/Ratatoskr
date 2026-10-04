import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type LeagueSnapshot } from '../domain/leagueOperations.js';
import {
  beginCleanLeagueAudit,
  beginDirtyLeagueAudit,
  confirmLeagueAuditCard,
  getLeagueAuditState,
  markLeagueAuditSendAttempted,
  setLeagueAuditNextRunAt,
  settleLeagueAuditCard,
} from '../db/repositories/leagueAudits.js';
import { recordLeagueAudit, resolveOpenLeagueReconciliationTickets } from '../db/repositories/leagueOperations.js';
import { LeagueSheetInputError, type LoadedLeagueSnapshot } from './leagueSheets.js';
import { runCoalescedLeagueAudit } from './leagueOperationCoordinator.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';

export type LeagueAuditCard = {
  title: string;
  description: string;
  footer: string;
  allowedMentions: false;
  actions?: Array<{ id: string; label: string }>;
};

export interface LeagueAuditCardPort {
  findByReference(reference: string): Promise<string | undefined>;
  send(card: LeagueAuditCard, reference: string): Promise<string>;
  delete(messageId: string): Promise<void>;
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
};

const LEAGUE_TIMEZONE = 'America/New_York';

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'),
    minute: value('minute'), second: value('second') };
}

function localTimeToUtc(parts: ZonedParts): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedParts(new Date(guess));
    const observedValue = Date.UTC(observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second);
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
    year: localDay.getUTCFullYear(), month: localDay.getUTCMonth() + 1, day: localDay.getUTCDate(),
    hour: 6, minute: 0, second: 0,
  });
}

function auditDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function cardFor(result: 'dirty' | 'error', issues: string[], now: Date, trigger: Input['trigger']): LeagueAuditCard {
  const intro = result === 'error'
    ? issues.length > 1
      ? `Ratatoskr stopped the audit because a roster sheet needs attention. No changes were made.\n\n${issues.join('\n')}\n\nAfter the sheet is corrected, the next audit will check it again automatically.`
      : 'Ratatoskr could not read Discord or one of the roster sheets. No changes were made. A Ratatoskr maintainer should check which connection failed; the next audit will retry automatically.'
    : `Ratatoskr found ${issues.length} item${issues.length === 1 ? ' that needs' : 's that need'} a league admin to review. Nothing was changed automatically.`;
  const categories = result === 'error' ? [] : [
    ['Player names', issues.filter((issue) => (issue.includes('Discord name now:')
      && issue.includes('Current Rosters sheet:') && issue.includes('Player Name History sheet:'))
      || (issue.includes('Current Rosters:') && issue.includes('Player Name History:') && issue.includes('Make the names match.'))).length],
    ['Departures or inactive players', issues.filter((issue) => issue.includes('no longer in the Discord server')).length],
    ['Discord roles', issues.filter((issue) => !issue.includes('no longer in the Discord server') && /Discord .*role|role in Discord|Discord division|Discord team/i.test(issue)).length],
    ['Roster sheets and setup', 0],
  ] as Array<[string, number]>;
  if (categories.length) categories[3]![1] = issues.length - categories.slice(0, 3).reduce((sum, entry) => sum + entry[1], 0);
  const summary = categories.filter(([, count]) => count > 0).map(([label, count]) => `• ${label}: ${count}`).join('\n');
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(now);
  return {
    title: result === 'error' ? 'League Roster Audit — Could Not Complete' : 'League Roster Audit — Action Required',
    description: `${intro}${summary ? `\n\n${summary}\n\nSelect **Review issues** for a private, step-by-step queue.` : ''}`,
    footer: `${trigger === 'startup' ? 'Startup' : 'Daily'} audit • ${time}`,
    allowedMentions: false,
    ...(result === 'dirty' ? { actions: [{ id: 'league-audit:review', label: 'Review issues' }] } : {}),
  };
}

export async function recoverPendingLeagueAudit(input: Pick<Input, 'db' | 'guildId' | 'cards'>): Promise<boolean> {
  let state = getLeagueAuditState(input.db, input.guildId);
  if (!state || state.phase === 'settled') return false;
  if (state.phase === 'send_pending') {
    let messageId = state.sendAttempted
      ? await input.cards.findByReference(state.runReference)
      : undefined;
    if (!messageId) {
      markLeagueAuditSendAttempted(input.db, input.guildId, state.runReference);
      messageId = await input.cards.send(
        cardFor(state.result === 'error' ? 'error' : 'dirty', state.findings, new Date(state.runAt), state.trigger),
        state.runReference,
      );
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

async function runLeagueAuditNow(input: Input): Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[]; cardId?: string }> {
  const recovered = await recoverPendingLeagueAudit(input);
  if (recovered) {
    const state = getLeagueAuditState(input.db, input.guildId)!;
    return { status: state.result, issues: state.findings,
      ...(state.currentMessageId ? { cardId: state.currentMessageId } : {}) };
  }
  let issues: string[];
  let result: 'clean' | 'dirty' | 'error';
  try {
    const members = await input.members.getMembers();
    const loaded = await input.sheets.load(members, input.freeAgentRoleId);
    issues = humanizeLeagueAuditIssues(loaded.snapshot, auditLeagueRoster(loaded.snapshot));
    result = issues.length ? 'dirty' : 'clean';
  } catch (error) {
    console.error('League roster audit could not read every source:', error);
    issues = error instanceof LeagueSheetInputError
      ? [
        `**What happened:** ${error.operationalSummary}`,
        `**What to do:** ${error.operationalNext}`,
        `**Error code:** ${error.operationalCode}`,
      ]
      : ['The audit could not read every required Discord and roster-sheet source.'];
    result = 'error';
  }
  recordLeagueAudit(input.db, {
    guildId: input.guildId,
    auditDate: auditDate(input.now),
    status: result === 'clean' ? 'passed' : 'failed',
    issues,
  });
  if (result === 'clean') {
    const reference = `YSL-AUD-${randomUUID().slice(0, 8).toUpperCase()}`;
    beginCleanLeagueAudit(input.db, {
      guildId: input.guildId,
      runReference: reference,
      runAt: input.now.toISOString(),
      trigger: input.trigger,
    });
    const state = getLeagueAuditState(input.db, input.guildId)!;
    if (state.staleMessageId) {
      await input.cards.delete(state.staleMessageId);
      settleLeagueAuditCard(input.db, input.guildId, reference);
    }
    resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
    return { status: 'clean', issues };
  }

  const reference = `YSL-AUD-${randomUUID().slice(0, 8).toUpperCase()}`;
  beginDirtyLeagueAudit(input.db, {
    guildId: input.guildId,
    result,
    findings: issues,
    runReference: reference,
    runAt: input.now.toISOString(),
    trigger: input.trigger,
  });
  markLeagueAuditSendAttempted(input.db, input.guildId, reference);
  const messageId = await input.cards.send(cardFor(result, issues, input.now, input.trigger), reference);
  confirmLeagueAuditCard(input.db, input.guildId, reference, messageId);
  const state = getLeagueAuditState(input.db, input.guildId)!;
  if (state.staleMessageId) await input.cards.delete(state.staleMessageId);
  settleLeagueAuditCard(input.db, input.guildId, reference);
  return { status: result, issues, cardId: messageId };
}

export function runLeagueAudit(input: Input): Promise<{ status: 'clean' | 'dirty' | 'error'; issues: string[]; cardId?: string }> {
  return runCoalescedLeagueAudit(input.operationScope, input.guildId, () => runLeagueAuditNow(input));
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
    timer = setTimer(() => {
      void input.run().catch((error) => console.error('Daily league roster audit failed:', error))
        .finally(schedule);
    }, Math.max(0, next.getTime() - current.getTime()));
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    setLeagueAuditNextRunAt(input.db, input.guildId, null);
  };
}
