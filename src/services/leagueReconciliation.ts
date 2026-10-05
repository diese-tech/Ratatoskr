import { randomUUID } from 'node:crypto';
import { listActionableLeagueJobs } from '../db/repositories/leagueJobs.js';
import { beginDirtyLeagueAudit, getLeagueAuditState, noteLeagueCheck } from '../db/repositories/leagueAudits.js';
import { stopCleanLeagueRetries } from '../db/repositories/leagueJobs.js';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type DiscordLeagueMember, type LeagueSnapshot } from '../domain/leagueOperations.js';
import {
  cacheVerifiedLeagueMember,
  getVerifiedLeagueMember,
  listLeagueFindings,
  memberMarker,
  replaceLeagueFindings,
} from '../db/repositories/leagueVerifiedState.js';
import {
  listOpenLeagueReconciliationTickets,
  listLeagueMutationProblems,
} from '../db/repositories/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import type { LeagueJobWorker } from './leagueJobWorker.js';
export function observeLeagueMember(
  db: Database.Database,
  worker: LeagueJobWorker,
  member: DiscordLeagueMember | null,
  discordId: string,
): boolean {
  const cached = getVerifiedLeagueMember(db, worker.guildId, discordId);
  if (cached && memberMarker(member, cached.managedRoleIds) === memberMarker(cached.member, cached.managedRoleIds))
    return false;
  // No event snapshot is executable; persist only the identity and fetch again.
  worker.enqueue('targeted', { discordId }, `member:${discordId}`, 2500);
  return true;
}
export async function checkLeagueMember(input: {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  discordId: string;
  freeAgentRoleId: string;
  now: Date;
  members: { getMember(id: string): Promise<DiscordLeagueMember | null> };
  sheets: {
    loadMember(id: string, member: DiscordLeagueMember | null, freeAgentRoleId: string): Promise<LeagueSnapshot>;
  };
}): Promise<void> {
  const release = await acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    const member = await input.members.getMember(input.discordId);
    const snapshot = await input.sheets.loadMember(input.discordId, member, input.freeAgentRoleId);
    const all = auditLeagueRoster(snapshot);
    const diagnostics = all.filter((issue) => issue.split(/\s+/).includes(input.discordId));
    replaceLeagueFindings(
      input.db,
      input.guildId,
      `member:${input.discordId}`,
      humanizeLeagueAuditIssues(snapshot, diagnostics),
      input.now,
    );
    // Public block diagnostics are shared resources, not duplicated per player.
    const affectedTeams = snapshot.teams.filter((team) =>
      snapshot.rosters.some((row) => row.discordId === input.discordId && row.teamRoleId === team.teamRoleId),
    );
    const affectedDivisions = snapshot.names
      .filter((row) => row.discordId === input.discordId)
      .map((row) => row.division);
    const relevant = (issue: string) =>
      affectedTeams.some((team) => issue.startsWith(`${team.division} ${team.franchise} `)) ||
      affectedDivisions.some(
        (division) => issue.startsWith(`${division} public free-agent`) || issue.startsWith(`${division} free agents`),
      );
    const old = listLeagueFindings(input.db, input.guildId).filter(
      (entry) => entry.resourceKey.startsWith('sheet:') && relevant(entry.resourceKey.slice(6)),
    );
    for (const entry of old) replaceLeagueFindings(input.db, input.guildId, entry.resourceKey, [], input.now);
    for (const issue of all.filter(relevant))
      replaceLeagueFindings(
        input.db,
        input.guildId,
        `sheet:${issue}`,
        humanizeLeagueAuditIssues(snapshot, [issue]),
        input.now,
      );
    cacheVerifiedLeagueMember(input.db, input.guildId, input.discordId, snapshot, input.now, 'targeted');
    if (!getLeagueAuditState(input.db, input.guildId))
      beginDirtyLeagueAudit(input.db, {
        guildId: input.guildId,
        result: diagnostics.length ? 'dirty' : 'clean',
        findings: humanizeLeagueAuditIssues(snapshot, diagnostics),
        runReference: `YSL-AUD-${randomUUID().slice(0, 8)}`,
        runAt: input.now.toISOString(),
        trigger: 'startup',
      });
    noteLeagueCheck(input.db, input.guildId, 'targeted', input.now);
  } finally {
    release();
  }
}
export const DIRTY_RECHECK_MS = 120_000;
export const PANEL_HEARTBEAT_MS = 3_600_000;
export function scheduleDirtyLeagueCheck(db: Database.Database, worker: LeagueJobWorker): boolean {
  if (
    !listLeagueFindings(db, worker.guildId).length &&
    !listOpenLeagueReconciliationTickets(db, worker.guildId).length &&
    !listLeagueMutationProblems(db, worker.guildId).length &&
    !listActionableLeagueJobs(db, worker.guildId).some((job) => job.status === 'RECONCILIATION_REQUIRED')
  ) {
    stopCleanLeagueRetries(db, worker.guildId);
    return false;
  }
  worker.enqueue('dirty', {}, 'dirty', DIRTY_RECHECK_MS);
  return true;
}

type TimerHandle = { unref?(): unknown };
export function startLeaguePanelHeartbeat(
  db: Database.Database,
  worker: LeagueJobWorker,
  options: {
    now?: () => Date;
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
  } = {},
): () => void {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let stopped = false;
  let timer: TimerHandle;
  const schedule = (delayMs: number) => {
    timer = setTimer(() => {
      if (stopped) return;
      worker.enqueue('heartbeat', {}, 'heartbeat');
      schedule(PANEL_HEARTBEAT_MS);
    }, delayMs);
    timer.unref?.();
  };
  const last = getLeagueAuditState(db, worker.guildId)?.lastRepostAt;
  schedule(last ? Math.max(0, new Date(last).getTime() + PANEL_HEARTBEAT_MS - now().getTime()) : PANEL_HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearTimer(timer);
  };
}
