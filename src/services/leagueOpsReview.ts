import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { escapeMarkdown } from 'discord.js';
import { getLeagueJob, getLeagueJobByDedupe, listActionableLeagueJobs, type LeagueJob } from '../db/repositories/leagueJobs.js';
import { getLeagueTransaction } from '../db/repositories/leagueOperations.js';
import { getLeagueAuditRepair, getLeagueRepairResolution, listIncompleteLeagueAuditRepairs } from '../db/repositories/leagueAuditRepairs.js';
import { getAccountReplacement } from '../db/repositories/leagueAccountReplacements.js';
import { getVerifiedLeagueMember, listLeagueFindings } from '../db/repositories/leagueVerifiedState.js';
import { LeagueMutationValidationError, type LeagueMutationPlan } from '../domain/leagueOperations.js';
import type { LeagueAccountReplacementService, AccountReplacementPreview } from './leagueAccountReplacement.js';
import { leagueTransactionPlanFingerprint } from './leagueTransactions.js';
import type { LeagueJobWorker } from './leagueJobWorker.js';
import { redactOperationalText } from './operationalErrors.js';
import { buildLeagueAuditResolutionView } from './leagueAuditReviewView.js';
import type { LeagueAuditResolutionAction } from './leagueAuditResolution.js';
import { getLeagueAuditState } from '../db/repositories/leagueAudits.js';
import { previewRegisteredLeagueRepairRecovery } from './leagueRepairRecovery.js';

export const leagueOpsText = (value: string, limit = 1400) => escapeMarkdown(redactOperationalText(value).slice(0, limit));
export function leagueRepairDedupeKey(action: string, finding: string, fingerprint: string): string {
  return `repair:v2:${action}:${createHash('sha256').update(finding).digest('hex')}:${fingerprint}`;
}
export function leagueOpsRepairAction(finding: string): LeagueAuditResolutionAction | undefined {
  const control = buildLeagueAuditResolutionView(finding, 0, 'private').actions.find(item => item.id.includes(':choice:'));
  return control?.id.split(':').at(-1) as LeagueAuditResolutionAction | undefined;
}
export type LeagueOpsIssue = { key: string; finding: string; oldDiscordId?: string };
export type LeagueOpsOperation = { reference: string; type: string; status: string; action: string; targets: string[];
  actor: string; createdAt: string; attempts: number; error: string; next: string; canRepreview: boolean; canRecover: boolean };
export type LeagueOpsSnapshot = { issues: LeagueOpsIssue[]; operations: LeagueOpsOperation[] };
export type ReviewTransactionPreview = { originalReference: string; selections: string; fingerprint: string; approval: string; plan: LeagueMutationPlan };
export type ReviewRepairPreview = { issueKey: string; finding: string; action: LeagueAuditResolutionAction; fingerprint: string; approvalReference: string; description: string };
export type ReviewRecoveryPreview = { reference: string; type: 'repair' | 'account-replacement'; fingerprint: string; approvalReference: string; description: string; canConfirm: boolean };

export class LeagueOpsReviewService {
  constructor(private readonly input: { db: Database.Database; guildId: string; scope: object; worker: LeagueJobWorker;
    replacement: LeagueAccountReplacementService; authorize(actor: string): Promise<string>;
    roleLabel?(id: string): string;
    previewTransaction(selections: string): Promise<LeagueMutationPlan>;
    previewRepair(finding: string, action: LeagueAuditResolutionAction): Promise<{ fingerprint: string; description: string }> }) {}

  async authorize(actor: string) { return this.input.authorize(actor); }
  private memberLabel(id: string) {
    const state = getVerifiedLeagueMember(this.input.db, this.input.guildId, id);
    return `${state?.member?.displayName ?? state?.rosters[0]?.player ?? state?.names[0]?.currentLeagueName ?? 'Account'} (${id})`;
  }
  private prewrite(job: LeagueJob) {
    const { db, guildId } = this.input;
    return job.type === 'transaction' && job.status === 'BLOCKED_REVIEW'
      && !(db.prepare('SELECT dismissed_at FROM league_jobs WHERE reference=?').get(job.reference) as { dismissed_at: string | null }).dismissed_at
      && !getLeagueTransaction(db, job.reference) && !getLeagueAuditRepair(db, job.reference)
      && !getAccountReplacement(db, guildId, job.reference);
  }
  private operation(job: LeagueJob): LeagueOpsOperation {
    const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
    let selections: unknown[] = [];
    try { if (typeof payload.selections === 'string') selections = JSON.parse(payload.selections); } catch { /* evidence remains inspectable */ }
    if (!Array.isArray(selections)) selections = [];
    const action = typeof payload.action === 'string' ? payload.action : typeof selections[0] === 'string' ? selections[0] : job.type;
    const playerSelections = selections[0] === 'pickup' || selections[0] === 'rename' ? selections.slice(1, 2) : selections.slice(1);
    const ids = [payload.oldDiscordId, payload.newDiscordId, ...playerSelections].filter((id): id is string => typeof id === 'string' && /^\d{16,20}$/.test(id));
    const expectedFinding = typeof payload.expectedFinding === 'string' ? payload.expectedFinding : '';
    const canRepreview = this.prewrite(job) && typeof payload.selections === 'string' && selections.length >= 2;
    const canRecover = job.status === 'RECONCILIATION_REQUIRED'
      && (job.type === 'repair' ? getLeagueAuditRepair(this.input.db, job.reference)?.status === 'reconciliation_required'
        : job.type === 'account-replacement' && getAccountReplacement(this.input.db, this.input.guildId, job.reference)?.status === 'reconciliation_required');
    const next = job.status === 'COMPLETED' ? 'Completed. Stored history remains available; do not repeat this operation.'
      : ['QUEUED', 'LOADING', 'VALIDATING', 'APPLYING', 'VERIFYING'].includes(job.status) ? 'Ratatoskr is processing this operation. Refresh for its durable result.'
      : job.status === 'RECONCILIATION_REQUIRED' ? 'Inspect the saved operation and fresh Discord/Sheets/history. Do not replay a possibly partial write.'
      : job.status === 'RETRYING' ? 'Ratatoskr will retry automatically. Refresh this view for current state.'
      : canRepreview ? 'Request a fresh preview of these selections, then explicitly confirm.'
      : job.type === 'repair' ? 'Inspect current roster/name Issues. If no matching issue remains, no repeat repair is needed. Original attempts remain as evidence.'
      : 'Review current state and configuration. No generic retry is available.';
    const targets = ids.length ? ids.map(id => this.memberLabel(id)) : expectedFinding ? [expectedFinding] : [];
    if (selections[0] === 'pickup' && typeof selections[2] === 'string') targets.push(`Team role: ${this.input.roleLabel?.(selections[2]) ?? selections[2]}`);
    if (selections[0] === 'rename' && typeof selections[2] === 'string') targets.push(`Requested league name: ${selections[2]}`);
    const originalReference = typeof payload.reconcileReference === 'string' ? payload.reconcileReference : payload.mode === 'reconcile' ? payload.reference : undefined;
    if (typeof originalReference === 'string') targets.push(`Reconciliation of original record: ${originalReference}`);
    const acknowledged = job.result && typeof job.result === 'object' && 'manuallyReconciled' in job.result && job.result.manuallyReconciled;
    return { reference: job.reference, type: job.type, status: acknowledged ? 'RECONCILED' : job.status, action: originalReference ? `reconcile ${job.type}` : action,
      targets,
      actor: typeof payload.actorName === 'string' ? payload.actorName : typeof payload.actorUserId === 'string' ? this.memberLabel(payload.actorUserId) : 'Background worker',
      createdAt: job.createdAt, attempts: job.attemptCount, error: job.lastError ?? 'No saved error.',
      next: acknowledged ? 'Explicitly reconciled against fresh state. The original mutation was not replayed.' : next, canRepreview, canRecover };
  }
  private legacyRepair(reference: string): LeagueOpsOperation | undefined {
    const repair = getLeagueAuditRepair(this.input.db, reference);
    if (!repair || repair.guildId !== this.input.guildId) return;
    const timestamp = this.input.db.prepare('SELECT created_at FROM league_audit_repairs WHERE reference=?').get(reference) as { created_at: string };
    const reconciled = getLeagueRepairResolution(this.input.db, this.input.guildId, reference);
    return { reference, type: 'repair', action: repair.action, status: reconciled ? 'RECONCILED' : ['applying', 'reconciliation_required'].includes(repair.status) ? 'RECONCILIATION_REQUIRED' : repair.status.toUpperCase(),
      targets: [repair.finding], actor: this.memberLabel(repair.actorUserId), createdAt: timestamp.created_at, attempts: 0,
      error: repair.errorMessage ?? 'Legacy repair record; inspect the saved outcome.', canRepreview: false,
      canRecover: !reconciled && repair.status === 'reconciliation_required',
      next: reconciled ? 'Explicitly reconciled against fresh state. The original mutation was not replayed.' : repair.status === 'completed' ? 'Completed. Preserved history is read-only.'
        : 'Inspect fresh convergence and preserved name/history records before explicitly acknowledging reconciliation. The old mutation will not be replayed.' };
  }
  async operationDetail(actor: string, reference: string): Promise<LeagueOpsOperation> {
    await this.authorize(actor);
    const job = getLeagueJob(this.input.db, reference);
    const detail = job?.guildId === this.input.guildId && ['transaction', 'repair', 'account-replacement'].includes(job.type)
      ? this.operation(job) : this.legacyRepair(reference);
    if (!detail) throw new LeagueMutationValidationError('This operation reference is unavailable in this guild.');
    return detail;
  }
  async snapshot(actor: string): Promise<LeagueOpsSnapshot> {
    await this.authorize(actor);
    const { db, guildId } = this.input;
    const operations = listActionableLeagueJobs(db, guildId).filter(job => ['transaction', 'repair', 'account-replacement'].includes(job.type)).map(job => this.operation(job));
    for (const repair of listIncompleteLeagueAuditRepairs(db).filter(repair => repair.guildId === guildId))
      if (!operations.some(operation => operation.reference === repair.reference)) operations.push(this.legacyRepair(repair.reference)!);
    return { issues: listLeagueFindings(db, guildId).flatMap(entry => entry.findings.map((finding, index) => {
      const id = entry.resourceKey.startsWith('member:') ? entry.resourceKey.slice(7) : undefined;
      const state = id ? getVerifiedLeagueMember(db, guildId, id) : undefined;
      return { key: `${entry.resourceKey}:${index}`, finding,
        ...(id && state?.rosters.length === 1 && !state.member ? { oldDiscordId: id } : {}) };
    })), operations };
  }
  async previewReplacement(actor: string, issueKey: string, oldId: string, newId: string): Promise<AccountReplacementPreview> {
    const current = await this.snapshot(actor);
    if (!current.issues.some(issue => issue.key === issueKey && issue.oldDiscordId === oldId))
      throw new LeagueMutationValidationError('This absent-account finding changed. Refresh Issues before choosing an account replacement.');
    const preview = await this.input.replacement.preview(actor, oldId, newId);
    await this.authorize(actor);
    return preview;
  }
  async confirmReplacement(actor: string, preview: AccountReplacementPreview, samePlayerConfirmed: boolean) {
    await this.authorize(actor);
    if (!samePlayerConfirmed) throw new LeagueMutationValidationError('Attest that the exact accounts belong to the same continuing player.');
    return this.input.replacement.confirm({ actorUserId: actor, oldDiscordId: preview.plan.oldDiscordId,
      newDiscordId: preview.plan.newDiscordId, expectedFingerprint: preview.fingerprint,
      approvalReference: preview.approvalReference, samePlayerConfirmed: true });
  }
  async previewTransaction(actor: string, reference: string): Promise<ReviewTransactionPreview> {
    await this.authorize(actor);
    const job = getLeagueJob(this.input.db, reference);
    if (!job || job.guildId !== this.input.guildId || !this.prewrite(job))
      throw new LeagueMutationValidationError('Only a proven pre-write blocked transaction can receive a fresh preview.');
    const selections = (job.payload as { selections: string }).selections;
    const plan = await this.input.previewTransaction(selections);
    await this.authorize(actor);
    return { originalReference: reference, selections, fingerprint: leagueTransactionPlanFingerprint(plan), approval: randomUUID(), plan };
  }
  async confirmTransaction(actor: string, preview: ReviewTransactionPreview) {
    const actorName = await this.authorize(actor);
    const key = `transaction:${actor}:${preview.selections}:${preview.approval}`;
    const existing = getLeagueJobByDedupe(this.input.db, this.input.guildId, key);
    if (existing) return existing;
    const original = getLeagueJob(this.input.db, preview.originalReference);
    if (!original || original.guildId !== this.input.guildId || !this.prewrite(original)
      || (original.payload as { selections: string }).selections !== preview.selections)
      throw new LeagueMutationValidationError('The original operation changed. Refresh and request a new preview.');
    return this.input.worker.enqueue('transaction', { actorUserId: actor, actorName, selections: preview.selections,
      expectedPlanFingerprint: preview.fingerprint, originalBlockedReference: preview.originalReference }, key);
  }
  async previewRepair(actor: string, key: string): Promise<ReviewRepairPreview> {
    const current = await this.snapshot(actor);
    const issue = current.issues.find(item => item.key === key);
    const action = issue && leagueOpsRepairAction(issue.finding);
    if (!issue || !action || issue.oldDiscordId) throw new LeagueMutationValidationError('This issue requires an account/departure decision or manual source review.');
    const preview = await this.input.previewRepair(issue.finding, action);
    await this.authorize(actor);
    return { ...preview, approvalReference: randomUUID(), issueKey: key, finding: issue.finding, action };
  }
  async confirmRepair(actor: string, preview: ReviewRepairPreview) {
    const actorName = await this.authorize(actor);
    const key = `${leagueRepairDedupeKey(preview.action, preview.finding, preview.fingerprint)}:${preview.approvalReference}`;
    const existing = getLeagueJobByDedupe(this.input.db, this.input.guildId, key);
    if (existing) return existing;
    const current = await this.snapshot(actor);
    if (!current.issues.some(item => item.key === preview.issueKey && item.finding === preview.finding)
      || leagueOpsRepairAction(preview.finding) !== preview.action) throw new LeagueMutationValidationError('The finding changed. Review a fresh preview.');
    const state = getLeagueAuditState(this.input.db, this.input.guildId);
    if (!state) throw new LeagueMutationValidationError('The current audit is unavailable. Recheck the roster.');
    return this.input.db.transaction(() => {
      const match = this.input.db.prepare(`SELECT reference FROM league_jobs WHERE guild_id=? AND type='repair'
        AND json_extract(payload_json,'$.expectedFinding')=? AND json_extract(payload_json,'$.action')=?
        AND json_extract(payload_json,'$.expectedRepairFingerprint')=? ORDER BY sequence DESC LIMIT 1`)
        .get(this.input.guildId, preview.finding, preview.action, preview.fingerprint) as { reference: string } | undefined;
      const latest = match && getLeagueJob(this.input.db, match.reference);
      const safelyBlocked = latest && ['BLOCKED_REVIEW', 'FAILED'].includes(latest.status) && !getLeagueAuditRepair(this.input.db, latest.reference);
      if (latest && !safelyBlocked) {
        this.input.db.prepare('INSERT INTO league_job_approvals VALUES(?,?,?)').run(this.input.guildId, key, latest.reference);
        return latest;
      }
      // A fresh explicit preview may recover a proven pre-write permission or
      // transient block. Duplicate clicks on that preview retain its unique key.
      return this.input.worker.enqueue('repair', { actorUserId: actor, actorName, auditReference: state.runReference,
        expectedFinding: preview.finding, action: preview.action, expectedRepairFingerprint: preview.fingerprint }, key);
    })();
  }
  async previewRecovery(actor: string, reference: string): Promise<ReviewRecoveryPreview> {
    await this.authorize(actor);
    const job = getLeagueJob(this.input.db, reference);
    const operation = await this.operationDetail(actor, reference);
    if (!operation.canRecover)
      throw new LeagueMutationValidationError('This operation does not have a recoverable interrupted record.');
    let result: ReviewRecoveryPreview;
    if (job?.type === 'account-replacement') {
      const preview = await this.input.replacement.previewRecovery(actor, reference);
      result = { reference, type: 'account-replacement', fingerprint: preview.fingerprint, approvalReference: preview.approvalReference, canConfirm: true,
        description: `${preview.plan.oldDiscordId} → ${preview.plan.newDiscordId}\n${preview.plan.rosterAfter.player}; ${preview.plan.rosterAfter.franchise}; ${preview.plan.rosterAfter.rosterStatus}.\nDraft Picks: ${preview.draftVerification}.\n${preview.plan.manualReview.join('\n')}` };
    } else {
      const preview = await previewRegisteredLeagueRepairRecovery(this.input.scope, this.input.guildId, reference);
      result = { reference, type: 'repair', fingerprint: preview.fingerprint, approvalReference: randomUUID(), canConfirm: !preview.findings.length,
        description: `${preview.repair.finding}\nFresh findings: ${preview.findings.join('\n') || 'none'}.` };
    }
    await this.authorize(actor);
    return result;
  }
  async confirmRecovery(actor: string, preview: ReviewRecoveryPreview, historyReviewed: boolean) {
    const actorName = await this.authorize(actor);
    if (!historyReviewed || !preview.canConfirm) throw new LeagueMutationValidationError('Review preserved history and reconcile current surfaces before acknowledging this operation.');
    if (preview.type === 'account-replacement') return this.input.replacement.confirmRecovery({ actorUserId: actor,
      reference: preview.reference, expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, historyReviewed: true });
    const repair = getLeagueAuditRepair(this.input.db, preview.reference);
    if (!repair || repair.guildId !== this.input.guildId) throw new LeagueMutationValidationError('This interrupted repair is not in this guild.');
    return this.input.worker.enqueue('repair', { actorUserId: actor, actorName, auditReference: repair.auditReference,
      expectedFinding: repair.finding, action: repair.action, reconcileReference: repair.reference, expectedRecoveryFingerprint: preview.fingerprint },
      `repair-recovery:${preview.reference}:${actor}:${preview.fingerprint}:${preview.approvalReference}`);
  }
}
