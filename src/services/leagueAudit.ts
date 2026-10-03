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
import type { LoadedLeagueSnapshot } from './leagueSheets.js';
import { runCoalescedLeagueAudit } from './leagueOperationCoordinator.js';

export type LeagueAuditCard = {
  title: string;
  description: string;
  footer: string;
  allowedMentions: false;
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
  const visible = issues.slice(0, 12).map((issue) => `- ${issue}`).join('\n');
  const remaining = issues.length > 12 ? `\n- ${issues.length - 12} more issue(s); inspect the audit log.` : '';
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(now);
  return {
    title: result === 'error' ? 'League Roster Audit — Could Not Complete' : 'League Roster Audit — Action Required',
    description: result === 'error'
      ? 'Ratatoskr could not read every required Discord and roster-sheet source. No changes were made. Check Railway logs, then let the next audit retry.'
      : `Ratatoskr found ${issues.length} mismatch${issues.length === 1 ? '' : 'es'} between Discord and the managed roster sheets. No changes were made.\n\n${visible}${remaining}`,
    footer: `${trigger === 'startup' ? 'Startup' : 'Daily'} audit • ${time}`,
    allowedMentions: false,
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
    issues = auditLeagueRoster(loaded.snapshot);
    result = issues.length ? 'dirty' : 'clean';
  } catch (error) {
    console.error('League roster audit could not read every source:', error);
    issues = ['The audit could not read every required Discord and roster-sheet source.'];
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
