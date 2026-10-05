import type Database from 'better-sqlite3';
import { type Client, type Guild } from 'discord.js';
import { hasAccess } from './authorization.js';
import {
  getLeagueTransaction,
  listOpenLeagueReconciliationTickets,
  listLeagueMutationProblems,
  hasPendingLeagueDeliveries,
} from '../db/repositories/leagueOperations.js';
import { getLeagueAuditRepair, markLeagueAuditRepairReconciliationRequired } from '../db/repositories/leagueAuditRepairs.js';
import { listActionableLeagueJobs, transitionLeagueJob } from '../db/repositories/leagueJobs.js';
import {
  getVerifiedLeagueMember,
  listLeagueFindings,
  listVerifiedLeagueMemberIds,
} from '../db/repositories/leagueVerifiedState.js';
import {
  executeLeagueTransaction,
  LeagueTransactionPreviewChangedError,
  reconcilePendingLeagueTransactions,
} from './leagueTransactions.js';
import {
  executeLeagueAuditRepair,
  LeagueAuditRepairNoWriteError,
  LeagueAuditRepairStaleError,
  type LeagueAuditResolutionAction,
} from './leagueAuditResolution.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { buildLeagueIntentPlan, type LeagueTransactionIntent } from './leagueTransactionIntent.js';
import { LeagueJobBlockedError, LeagueJobWorker, registerLeagueJobWorker } from './leagueJobWorker.js';
import { checkLeagueMember, scheduleDirtyLeagueCheck, startLeaguePanelHeartbeat } from './leagueReconciliation.js';
import { refreshLeagueOpsPanel, runLeagueAudit, type LeagueAuditCardPort } from './leagueAudit.js';
import { createLeagueAuditCardPort } from './leagueAuditDiscord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import type { LeagueSheetsService } from './leagueSheets.js';
import { registerLeagueRepairRecovery, reconcileLeagueRepairRecord } from './leagueRepairRecovery.js';
export type LeagueRepairIntent = {
  actorUserId: string;
  actorName: string;
  auditReference: string;
  expectedFinding: string;
  action: LeagueAuditResolutionAction;
  reconcileReference?: string;
  expectedRecoveryFingerprint?: string;
};
type LeagueOpsSheets = Pick<
  LeagueSheetsService,
  'load' | 'loadMember' | 'assertUnchanged' | 'prepare' | 'apply' | 'appendTransactionHistory'
>;
export function createLeagueOpsRuntime(input: {
  db: Database.Database;
  operationScope: object;
  client: Client;
  guild: Guild;
  sheets: LeagueOpsSheets;
  freeAgentRoleId: string;
  transactionsChannelId: string;
  discord?: DiscordLeagueGateway;
  cards?: LeagueAuditCardPort;
}): { worker: LeagueJobWorker; stop(): void } {
  const { db, operationScope, guild, sheets, freeAgentRoleId } = input;
  const guildId = guild.id;
  const discord = input.discord ?? new DiscordLeagueGateway(guild, input.transactionsChannelId);
  const cards = input.cards ?? createLeagueAuditCardPort(input.client, db, guildId);
  registerLeagueRepairRecovery({ db, operationScope, guildId, sheets, members: discord, freeAgentRoleId });
  let worker: LeagueJobWorker;
  const refresh = () => {
    worker.enqueue('panel', {}, 'panel', 500);
    scheduleDirtyLeagueCheck(db, worker);
  };
  const authorize = async (actorUserId: string) => {
    const member = await guild.members.fetch({ user: actorUserId, force: true });
    if (!hasAccess(member, 'ADMIN'))
      throw new LeagueJobBlockedError(
        'BLOCKED_REVIEW',
        'The approving administrator no longer has access. Ask a league administrator to review this operation.',
      );
  };
  const audit = async (trigger: 'startup' | 'scheduled') => {
    const result = await runLeagueAudit({
      db,
      operationScope,
      guildId,
      trigger,
      now: new Date(),
      freeAgentRoleId,
      members: discord,
      sheets,
      cards,
      deferPresentation: true,
      freshAfterRecovery: true,
    });
    refresh();
    return result;
  };
  const targeted = async (discordId: string) => {
    await checkLeagueMember({
      db,
      operationScope,
      guildId,
      discordId,
      freeAgentRoleId,
      now: new Date(),
      members: discord,
      sheets,
    });
    refresh();
  };
  worker = new LeagueJobWorker(
    db,
    guildId,
    {
      transaction: async (job, phase) => {
        const intent = job.payload as LeagueTransactionIntent;
        try {
          await authorize(intent.actorUserId);
          const result = await executeLeagueTransaction({
            db,
            operationScope,
            guildId,
            actorUserId: intent.actorUserId,
            actorName: intent.actorName,
            freeAgentRoleId,
            now: new Date(),
            sheets,
            discord,
            buildPlan: (snapshot) => buildLeagueIntentPlan(intent.selections, snapshot),
            expectedPlanFingerprint: intent.expectedPlanFingerprint,
            jobReference: job.reference,
            onPhase: phase,
          });
          // Refresh using fresh sources; never promote an executable preview to cache authority.
          await audit('scheduled');
          return result;
        } catch (error) {
          if (error instanceof LeagueTransactionPreviewChangedError) {
            // This fingerprint is reviewable but is not an approval for a changed mutation.
            throw new LeagueJobBlockedError('BLOCKED_REVIEW', error.message, { plan: error.plan });
          }
          const transaction = getLeagueTransaction(db, job.reference);
          if (transaction?.status === 'completed') return { reference: job.reference };
          if (transaction?.status === 'announcement_pending')
            throw new LeagueJobBlockedError(
              'RECONCILIATION_REQUIRED',
              'The roster change is complete; its public notice/history remains pending recovery.',
              { canonicalComplete: true, pendingDelivery: true },
            );
          if (
            transaction?.status === 'reconciliation_required' ||
            transaction?.status === 'applying_discord' ||
            transaction?.status === 'applying_sheets'
          )
            throw new LeagueJobBlockedError(
              'RECONCILIATION_REQUIRED',
              'This operation may be partial. Review Discord and the roster sheets before any further mutation.',
            );
          if (transaction?.status === 'failed')
            throw new LeagueJobBlockedError(
              'FAILED',
              'The operation failed safely. Review its reference before trying again.',
            );
          if (error instanceof LeagueMutationValidationError)
            throw new LeagueJobBlockedError('BLOCKED_REVIEW', error.message);
          if (error && typeof error === 'object' && 'leagueReconciliationTicket' in error)
            throw new LeagueJobBlockedError('BLOCKED_REVIEW', error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          refresh();
        }
      },
      repair: async (job, phase) => {
        const intent = job.payload as LeagueRepairIntent;
        try {
          await authorize(intent.actorUserId);
          phase('VALIDATING');
          if (intent.reconcileReference) {
            await reconcileLeagueRepairRecord({ db, operationScope, guildId, sheets, members: discord, freeAgentRoleId,
              reference: intent.reconcileReference, expectedFingerprint: intent.expectedRecoveryFingerprint ?? '', actorUserId: intent.actorUserId });
            await audit('scheduled');
            return { reference: intent.reconcileReference, manuallyReconciled: true };
          }
          const result = await executeLeagueAuditRepair({
            ...intent,
            db,
            operationScope,
            guildId,
            now: new Date(),
            freeAgentRoleId,
            members: discord,
            sheets,
            discord,
            jobReference: job.reference,
            onApplying: () => phase('APPLYING'),
          });
          phase('VERIFYING');
          await audit('scheduled');
          return result;
        } catch (error) {
          if (getLeagueAuditRepair(db, job.reference)?.status === 'completed') return { reference: job.reference };
          if (error instanceof LeagueAuditRepairStaleError) {
            await audit('scheduled');
            return { reference: job.reference, alreadyResolved: true };
          }
          if (error instanceof LeagueAuditRepairNoWriteError)
            throw new LeagueJobBlockedError('BLOCKED_REVIEW', error.message);
          throw error;
        } finally {
          refresh();
        }
      },
      targeted: async (job) => {
        await targeted((job.payload as { discordId: string }).discordId);
      },
      panel: async () => refreshLeagueOpsPanel({ db, guildId, cards, now: new Date() }),
      dirty: async () => {
        const findings = listLeagueFindings(db, guildId);
        const required = listActionableLeagueJobs(db, guildId).filter(
          (job) => job.status === 'RECONCILIATION_REQUIRED',
        );
        if (
          !findings.length &&
          !listOpenLeagueReconciliationTickets(db, guildId).length &&
          !listLeagueMutationProblems(db, guildId).length &&
          !hasPendingLeagueDeliveries(db, guildId) &&
          !required.length
        )
          return;
        // Public notices and history retain the existing durable retry contract.
        // This recovery function never replays interrupted role/sheet mutations.
        await reconcilePendingLeagueTransactions({ db, sheets, discord });
        for (const job of required)
          if (getLeagueTransaction(db, job.reference)?.status === 'completed')
            transitionLeagueJob(db, job.reference, 'COMPLETED', { result: { reference: job.reference } });
        const ids = new Set(
          findings.filter((f) => f.resourceKey.startsWith('member:')).map((f) => f.resourceKey.slice(7)),
        );
        for (const job of required) {
          const transaction = getLeagueTransaction(db, job.reference);
          const payload = transaction?.payload as { plan?: { playerIds?: string[] } } | undefined;
          for (const id of payload?.plan?.playerIds ?? []) ids.add(id);
        }
        // A known sheet block can be rechecked through any cached identity in it.
        const cached = listVerifiedLeagueMemberIds(db, guildId);
        for (const entry of cached) {
          const state = getVerifiedLeagueMember(db, guildId, entry)!;
          if (
            findings.some(
              (f) =>
                f.resourceKey.startsWith('sheet:') &&
                [...state.rosters, ...state.names].some(
                  (row) =>
                    f.resourceKey.includes(`${row.division} ${row.franchise} `) ||
                    f.resourceKey.includes(`${row.division} public free-agent`),
                ),
            )
          )
            ids.add(entry);
        }
        if (ids.size && !findings.some((f) => f.resourceKey === 'connection')) for (const id of ids) await targeted(id);
        else await audit('scheduled');
        // Release the running key before scheduling the next 2-minute pass.
        scheduleDirtyLeagueCheck(db, worker);
      },
      audit: async (job) => audit((job.payload as { trigger: 'startup' | 'scheduled' }).trigger),
      heartbeat: async (job) => refreshLeagueOpsPanel({ db, guildId, cards, now: new Date(), repost: true, repostQueuedAt: job.createdAt }),
    },
    async (job) => {
      const transaction = getLeagueTransaction(db, job.reference);
      const repair = getLeagueAuditRepair(db, job.reference);
      if (transaction?.status === 'completed' || repair?.status === 'completed') {
        transitionLeagueJob(db, job.reference, 'COMPLETED');
        return;
      }
      if (repair?.status === 'applying')
        markLeagueAuditRepairReconciliationRequired(db, repair.reference,
          'Repair was interrupted during an external write. Review and explicitly reconcile the recorded operation; do not replay it.');
      // Recovery inspects fresh sources, but convergence alone cannot prove an
      // interrupted external write's approved history/notice was committed.
      try {
        await sheets.load(await discord.getMembers(), freeAgentRoleId);
      } catch (error) {
        console.error('Fresh league recovery check unavailable:', error);
      }
      if (!transaction && !repair && ['LOADING', 'VALIDATING'].includes(job.status))
        transitionLeagueJob(db, job.reference, 'QUEUED');
      else
        transitionLeagueJob(db, job.reference, 'RECONCILIATION_REQUIRED', {
          error: 'Interrupted external mutation. Check the transaction/repair reference before retrying.',
        });
    },
  );
  worker.stop();
  registerLeagueJobWorker(operationScope, worker);
  const stopHeartbeat = startLeaguePanelHeartbeat(db, worker);
  return {
    worker,
    stop: () => {
      stopHeartbeat();
      worker.stop();
    },
  };
}
