import { leagueFindingKind } from './leagueAuditPresentation.js';
import { parseReinstatementSelection } from './leagueTransactionIntent.js';
import { listLeagueMutationProblems, listOpenLeagueReconciliationTickets } from '../db/repositories/leagueOperations.js';
import { leagueEasternTime } from './leaguePresentation.js';
import { draftSnapshotStatus } from './leagueStatusSnapshot.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { escapeMarkdown } from 'discord.js';
import { completedLeagueTransactionSuccessor, getLeagueJob, getLeagueJobByDedupe, listUnfinishedLeagueMutationJobs, type LeagueJob } from '../db/repositories/leagueJobs.js';
import { getLeagueTransaction, listLeagueTransactions } from '../db/repositories/leagueOperations.js';
import { getLeagueAuditRepair, getLeagueRepairResolution, listIncompleteLeagueAuditRepairs } from '../db/repositories/leagueAuditRepairs.js';
import { getAccountReplacement } from '../db/repositories/leagueAccountReplacements.js';
import { getVerifiedLeagueMember, listLeagueFindings } from '../db/repositories/leagueVerifiedState.js';
import { DRAFT_PICK_FEATURE } from './draftPickTracking.js';
import { currentLeagueMembership, LeagueMutationValidationError, type LeagueMutationPlan } from '../domain/leagueOperations.js';
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
export type ReviewAccountReplacementPreview = AccountReplacementPreview & { roleLabels?: Record<string, string> };
export type LeagueOpsIssue = { key: string; finding: string; oldDiscordId?: string; requiresManualReview?: boolean };
export type LeagueOpsOperation = { reference: string; type: string; status: string; action: string; targets: string[];
  actor: string; createdAt: string; attempts: number; error: string; next: string; canRepreview: boolean; canRecover: boolean; historyDetails?: string[]; linkedReferences?: string[] };
export type LeagueOpsSnapshot = { issues: LeagueOpsIssue[]; operations: LeagueOpsOperation[]; checkDetails?: string[]; draftNeedsAttention?: boolean };
export type ReviewTransactionPreview = { originalReference: string; selections: string; fingerprint: string; approval: string; plan: LeagueMutationPlan };
export type ReviewRepairPreview = { issueKey: string; finding: string; action: LeagueAuditResolutionAction; fingerprint: string; approvalReference: string; description: string };
export type ReviewRecoveryPreview = { reference: string; type: 'repair' | 'account-replacement'; fingerprint: string; approvalReference: string; description: string; canConfirm: boolean };

export class LeagueOpsReviewService {
  constructor(private readonly input: { db: Database.Database; guildId: string; scope: object; worker: LeagueJobWorker;
    replacement: LeagueAccountReplacementService; authorize(actor: string): Promise<string>;
    readTransactionHistory?(): Promise<(string | number | boolean | null)[][]>;
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
    const selections = (job.payload as { selections?: unknown })?.selections;
    const superseding = db.prepare(`SELECT 1 FROM league_jobs later WHERE later.guild_id=? AND later.type='transaction'
      AND later.sequence>(SELECT sequence FROM league_jobs WHERE reference=?)
      AND (json_extract(later.payload_json,'$.originalBlockedReference')=? OR json_extract(later.payload_json,'$.selections')=?)
      AND (later.status NOT IN ('BLOCKED_REVIEW','FAILED') OR EXISTS(SELECT 1 FROM league_transactions t WHERE t.reference=later.reference)) LIMIT 1`)
      .get(guildId, job.reference, job.reference, typeof selections === 'string' ? selections : '') as unknown;
    return job.type === 'transaction' && job.status === 'BLOCKED_REVIEW'
      && !superseding
      && !(db.prepare('SELECT dismissed_at FROM league_jobs WHERE reference=?').get(job.reference) as { dismissed_at: string | null }).dismissed_at
      && !getLeagueTransaction(db, job.reference) && !getLeagueAuditRepair(db, job.reference)
      && !getAccountReplacement(db, guildId, job.reference);
  }
  private operation(job: LeagueJob): LeagueOpsOperation {
    const successor = completedLeagueTransactionSuccessor(this.input.db, job);
    const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
    let selections: unknown[] = [];
    let reinstatement: ReturnType<typeof parseReinstatementSelection>;
    try { if (typeof payload.selections === 'string') reinstatement = parseReinstatementSelection(payload.selections); } catch { /* malformed stored evidence cannot authorize a preview */ }
    try { if (typeof payload.selections === 'string') selections = JSON.parse(payload.selections); } catch { /* evidence remains inspectable */ }
    if (!Array.isArray(selections)) selections = [];
    const action = reinstatement ? 'reinstate' : typeof payload.action === 'string' ? payload.action : selections[0] === 'trade-one-way' ? 'trade' : typeof selections[0] === 'string' ? selections[0] : job.type;
    const playerSelections = reinstatement ? [reinstatement.playerId] : selections[0] === 'pickup' || selections[0] === 'trade-one-way' || selections[0] === 'rename' ? selections.slice(1, 2) : selections.slice(1);
    const ids = [payload.oldDiscordId, payload.newDiscordId, ...playerSelections].filter((id): id is string => typeof id === 'string' && /^\d{16,20}$/.test(id));
    const expectedFinding = typeof payload.expectedFinding === 'string' ? payload.expectedFinding : '';
    const canRepreview = this.prewrite(job) && typeof payload.selections === 'string' && selections.length >= 2;
    const canRecover = job.status === 'RECONCILIATION_REQUIRED'
      && (job.type === 'repair' ? getLeagueAuditRepair(this.input.db, job.reference)?.status === 'reconciliation_required'
        : job.type === 'account-replacement' && getAccountReplacement(this.input.db, this.input.guildId, job.reference)?.status === 'reconciliation_required');
    const next = job.status === 'COMPLETED' ? 'Finished. The history is saved; do not run this action again.'
      : ['QUEUED', 'LOADING', 'VALIDATING', 'APPLYING', 'VERIFYING'].includes(job.status) ? 'Rat is working on this action. Reload saved status to check its progress; do not submit it again.'
      : job.status === 'RECONCILIATION_REQUIRED' ? 'Check the saved action, Discord, sheets and history. Some changes may already have happened. Do not run it again.'
      : job.status === 'RETRYING' ? 'Rat will try again automatically. Reload saved status to check progress.'
      : canRepreview ? 'Preview the player change again, review it, then confirm.'
      : job.type === 'repair' ? 'Check Roster problems for this player. If the problem is gone, no new fix is needed. Earlier attempts stay in history.'
      : 'Check the latest records and settings with staff before trying another action.';
    const targets = ids.length ? ids.map(id => this.memberLabel(id)) : expectedFinding ? [expectedFinding] : [];
    if (reinstatement) targets.push(`Original exit: ${reinstatement.sourceReference}; requested status: ${reinstatement.returnStatus}; official proposed date: ${reinstatement.effectiveDate}.`);
    if ((selections[0] === 'pickup' || selections[0] === 'trade-one-way') && typeof selections[2] === 'string') targets.push(`Team role: ${this.input.roleLabel?.(selections[2]) ?? selections[2]}`);
    if (selections[0] === 'rename' && typeof selections[2] === 'string') targets.push(`Requested league name: ${selections[2]}`);
    const originalReference = typeof payload.reconcileReference === 'string' ? payload.reconcileReference : payload.mode === 'reconcile' ? payload.reference : undefined;
    if (typeof originalReference === 'string') targets.push(`Checking the earlier saved action: ${originalReference}`);
    const acknowledged = job.result && typeof job.result === 'object' && 'manuallyReconciled' in job.result && job.result.manuallyReconciled;
    return { reference: job.reference, type: job.type, status: successor ? 'SUPERSEDED' : acknowledged ? 'RECONCILED' : job.status, action: originalReference ? `reconcile ${job.type}` : action,
      targets,
      actor: typeof payload.actorName === 'string' ? payload.actorName : typeof payload.actorUserId === 'string' ? this.memberLabel(payload.actorUserId) : 'Rat',
      createdAt: job.createdAt, attempts: job.attemptCount, error: job.lastError ?? 'No saved error.',
      next: successor ? `Resolved by ${successor}. That later action finished successfully. This original attempt made no changes and stays in history; do not run it again.`
        : acknowledged ? 'Checked against the latest records and closed. The original change was not run again.' : next,
      canRepreview: !successor && canRepreview, canRecover: !successor && canRecover };
  }
  private legacyRepair(reference: string): LeagueOpsOperation | undefined {
    const repair = getLeagueAuditRepair(this.input.db, reference);
    if (!repair || repair.guildId !== this.input.guildId) return;
    const timestamp = this.input.db.prepare('SELECT created_at FROM league_audit_repairs WHERE reference=?').get(reference) as { created_at: string };
    const reconciled = getLeagueRepairResolution(this.input.db, this.input.guildId, reference);
    return { reference, type: 'repair', action: repair.action, status: reconciled ? 'RECONCILED' : ['applying', 'reconciliation_required'].includes(repair.status) ? 'RECONCILIATION_REQUIRED' : repair.status.toUpperCase(),
      targets: [repair.finding], actor: this.memberLabel(repair.actorUserId), createdAt: timestamp.created_at, attempts: 0,
      error: repair.errorMessage ?? 'Earlier fix; check the saved result.', canRepreview: false,
      canRecover: !reconciled && repair.status === 'reconciliation_required',
      next: reconciled ? 'Checked against the latest records and closed. The original change was not run again.' : repair.status === 'completed' ? 'Finished. The history is kept for review.'
        : 'Check that Discord and the sheets agree, then review the saved names and history before closing this action. The old change will not run again.' };
  }
  private legacyTransaction(reference: string): LeagueOpsOperation | undefined {
    const transaction = getLeagueTransaction(this.input.db, reference);
    if (!transaction || transaction.guildId !== this.input.guildId) return;
    const plan = (transaction.payload as { plan?: LeagueMutationPlan }).plan;
    const timing = this.input.db.prepare('SELECT created_at FROM league_transactions WHERE reference=?').get(reference) as { created_at: string };
    return { reference, type: 'transaction', action: transaction.kind, status: transaction.status === 'completed' ? 'COMPLETED' : transaction.status.toUpperCase(),
      targets: plan?.players ?? [], actor: transaction.actorUserId, createdAt: timing.created_at, attempts: 0,
      error: transaction.errorMessage ?? 'No saved error.', canRepreview: false, canRecover: false,
      next: transaction.status === 'completed' ? 'Finished. The original history is preserved.' : 'Inspect this saved action and its records with staff. Do not repeat it.' };
  }
  private async linkedHistory(detail: LeagueOpsOperation): Promise<LeagueOpsOperation> {
    const { db, guildId } = this.input;
    const transaction = getLeagueTransaction(db, detail.reference);
    if (!transaction || transaction.guildId !== guildId) return detail;
    const plan = (transaction.payload as { plan?: LeagueMutationPlan }).plan;
    const source = plan?.reinstatement?.source;
    const returns = listLeagueTransactions(db, guildId).filter(item =>
      (item.payload as { plan?: LeagueMutationPlan }).plan?.reinstatement?.source.reference === detail.reference);
    if (!source && !returns.length) return detail;
    const rows = await this.input.readTransactionHistory?.();
    const matches = rows?.filter(row => String(row[0]) === detail.reference && String(row[6]) === plan?.playerIds[0]);
    const date = matches?.length === 1 ? String(matches[0]![2]) : 'Unavailable — check Transaction History before relying on the date';
    return { ...detail, action: transaction.kind, targets: plan?.players ?? detail.targets, historyDetails: [
      `Official Sheet effective date: ${date}`,
      ...(source ? [`Original ${source.kind}: ${source.reference}; official Sheet date at approval: ${source.effectiveDate}; processed by ${source.processedBy}.`,
        `${source.franchise} → ${source.resultingStatus}; reinstatement destination: ${plan!.teams[0]!.franchise}.`,
        `Approved staff advisories: ${plan!.reinstatement!.selection.overrides.join(', ')}. Next-season penalties were not waived.`,
        ...(plan!.reinstatement!.selection.reason ? [`Staff reason: ${plan!.reinstatement!.selection.reason}`] : [])] : []),
      ...returns.map(item => `Linked reinstatement: ${item.reference}; ${item.status === 'completed' ? 'Completed' : 'not completed; inspect saved action'}.`),
      'Exact elapsed time unavailable. Requested/completed times are separate from the official Sheet date.',
    ], linkedReferences: [...(source ? [source.reference] : []), ...returns.map(item => item.reference)] };
  }
  async operationDetail(actor: string, reference: string, savedOnly = false): Promise<LeagueOpsOperation> {
    await this.authorize(actor);
    const job = getLeagueJob(this.input.db, reference);
    const detail = job?.guildId === this.input.guildId && ['transaction', 'repair', 'account-replacement'].includes(job.type)
      ? this.operation(job) : this.legacyRepair(reference) ?? this.legacyTransaction(reference);
    if (!detail) throw new LeagueMutationValidationError('This saved action was not found in this server. Check its reference.');
    return savedOnly ? detail : this.linkedHistory(detail);
  }
  async snapshot(actor: string): Promise<LeagueOpsSnapshot> {
    await this.authorize(actor);
    const { db, guildId } = this.input;
    const operations = listUnfinishedLeagueMutationJobs(db, guildId).filter(job => ['transaction', 'repair', 'account-replacement'].includes(job.type)).map(job => this.operation(job));
    for (const repair of listIncompleteLeagueAuditRepairs(db).filter(repair => repair.guildId === guildId))
      if (!operations.some(operation => operation.reference === repair.reference)) operations.push(this.legacyRepair(repair.reference)!);
    const resources = listLeagueFindings(db, guildId);
    const audit = getLeagueAuditState(db, guildId);
    const draft = resources.find(entry => entry.resourceKey === DRAFT_PICK_FEATURE);
    const format = (value: string) => value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, timestamp => leagueEasternTime(timestamp));
    return { checkDetails: [
      'This panel lets you look at problems and confirm fixes. Check again only reads Discord and our records; it never changes the roster.',
      ...resources.filter(entry => entry.resourceKey === 'connection').flatMap(entry => entry.findings.map(format)),
      ...listOpenLeagueReconciliationTickets(db, guildId).map(ticket => `Roster problem: ${ticket.summary}`),
      ...listLeagueMutationProblems(db, guildId).map(reference => `Unfinished action: ${reference}. Some changes may already have happened. Open it in Saved actions; don’t run the player change again.`),
      `Panel reference: ${audit?.runReference ?? 'Not available'}`,
      `Last full roster check: ${leagueEasternTime(audit?.lastFullAt)}`, `Last player check: ${leagueEasternTime(audit?.lastTargetedAt)}`,
      ...(draft?.findings.map(format) ?? ['Draft records have not been checked yet.']),
    ], draftNeedsAttention: draftSnapshotStatus(draft?.findings) !== 'ready', issues: resources.filter(entry => entry.resourceKey !== DRAFT_PICK_FEATURE).flatMap(entry => entry.findings.map((finding, index) => {
      const id = entry.resourceKey.startsWith('member:') ? entry.resourceKey.slice(7) : undefined;
      const state = id ? getVerifiedLeagueMember(db, guildId, id) : undefined;
      const membership = id && state ? currentLeagueMembership(state, id) : undefined;
      return { key: `${entry.resourceKey}:${index}`, finding,
        ...(id && state && !state.member && membership?.primary && leagueFindingKind(finding) === 'departed' ? { oldDiscordId: id } : {}),
        ...(id && (!state || (!state.member && !membership)) ? { requiresManualReview: true } : {}) };
    })), operations };
  }
  async previewReplacement(actor: string, issueKey: string, oldId: string, newId: string): Promise<ReviewAccountReplacementPreview> {
    const current = await this.snapshot(actor);
    if (!current.issues.some(issue => issue.key === issueKey && issue.oldDiscordId === oldId))
      throw new LeagueMutationValidationError('This player’s account or roster problem changed. Refresh Roster problems before choosing an account change.');
    const preview = await this.input.replacement.preview(actor, oldId, newId);
    await this.authorize(actor);
    return { ...preview, roleLabels: Object.fromEntries(preview.plan.roles.flatMap(role => [...role.add, ...role.remove])
      .map(id => [id, this.input.roleLabel?.(id) ?? `League role (${id})`])) };
  }
  async confirmReplacement(actor: string, preview: AccountReplacementPreview, samePlayerConfirmed: boolean) {
    await this.authorize(actor);
    if (!samePlayerConfirmed) throw new LeagueMutationValidationError('Confirm that both Discord accounts belong to the same player.');
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
    if (!issue || !action || issue.oldDiscordId || issue.requiresManualReview) throw new LeagueMutationValidationError('This issue requires an account/departure decision or manual source review.');
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
      if (latest && latest.status !== 'COMPLETED' && !safelyBlocked) {
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
        description: `${preview.plan.oldDiscordId} → ${preview.plan.newDiscordId}\n${preview.plan.rosterAfter.player}; ${preview.plan.rosterAfter.franchise}; ${preview.plan.rosterAfter.rosterStatus}.\nDraft Picks: ${draftPickVerificationText(preview.draftVerification)}.\n${preview.plan.manualReview.join('\n')}` };
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
import { draftPickVerificationText } from './draftPickTracking.js';
