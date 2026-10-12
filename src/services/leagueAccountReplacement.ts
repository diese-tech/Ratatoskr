import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { buildLeagueAccountReplacementPlan, type AccountReplacementMember, type AccountReplacementRoleChange,
  type LeagueAccountReplacementPlan } from '../domain/leagueAccountReplacement.js';
import { assertAccountReplacementAvailable, createAccountReplacement, getAccountReplacement,
  transitionAccountReplacement, type AccountReplacementRecord } from '../db/repositories/leagueAccountReplacements.js';
import { getLeagueJob, getLeagueJobByDedupe, listActionableLeagueJobs, transitionLeagueJob,
  type LeagueJob, type LeagueJobStatus } from '../db/repositories/leagueJobs.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { LeagueSheetDriftError, LeagueSheetReconciliationRequiredError, type LeagueSheetsService, type PreparedAccountReplacementSheets } from './leagueSheets.js';

export type AccountReplacementIntent = {
  actorUserId: string; oldDiscordId: string; newDiscordId: string; expectedFingerprint: string; approvalReference: string; samePlayerConfirmed: true;
};
export type AccountReplacementRecoveryIntent = {
  mode: 'reconcile'; actorUserId: string; reference: string; expectedFingerprint: string; approvalReference: string; historyReviewed: true;
};
export type AccountReplacementPreview = {
  approvalReference: string;
  plan: LeagueAccountReplacementPlan; fingerprint: string; draftVerification: PreparedAccountReplacementSheets['draftVerification'];
  preservedJobReferences: string[];
};
type Inspection = Omit<AccountReplacementPreview, 'approvalReference'> & {
  prepared: PreparedAccountReplacementSheets; oldMember: AccountReplacementMember | null; newMember: AccountReplacementMember;
  afterFingerprint: string;
};
export type AccountReplacementDiscord = {
  getAccountReplacementMembers(): Promise<AccountReplacementMember[]>;
  getAccountReplacementMember(discordId: string): Promise<AccountReplacementMember | null>;
  assertAccountReplacementRoleOwnership(changes: AccountReplacementRoleChange[]): Promise<void>;
  reconcileAccountReplacementRoles(change: AccountReplacementRoleChange): Promise<void>;
};
export type AccountReplacementSheets = Pick<LeagueSheetsService, 'load' | 'prepareAccountReplacement'
  | 'assertAccountReplacementUnchanged' | 'applyAccountReplacement' | 'verifyAccountReplacement'>;
type Input = {
  db: Database.Database; operationScope: object; guildId: string; freeAgentRoleId: string;
  sheets: AccountReplacementSheets; discord: AccountReplacementDiscord;
  authorize(actorUserId: string): Promise<void>;
  enqueue(payload: AccountReplacementIntent | AccountReplacementRecoveryIntent, dedupeKey: string): LeagueJob;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedMember = (member: AccountReplacementMember | null) => member && { ...member, roleIds: [...member.roleIds].sort() };

// UI callers plan and confirm; execution and restart recovery belong to the canonical worker.
export class LeagueAccountReplacementService {
  constructor(private readonly input: Input) {}

  private async inspect(actorUserId: string, oldDiscordId: string, newDiscordId: string, reference = ''): Promise<Inspection> {
    const i = this.input;
    await i.authorize(actorUserId);
    assertAccountReplacementAvailable(i.db, i.guildId, oldDiscordId, newDiscordId, reference);
    const members = await i.discord.getAccountReplacementMembers();
    const oldMember = await i.discord.getAccountReplacementMember(oldDiscordId);
    const newMember = await i.discord.getAccountReplacementMember(newDiscordId);
    const freshMembers = members.filter((member) => member.discordId !== oldDiscordId && member.discordId !== newDiscordId);
    if (oldMember) freshMembers.push(oldMember);
    if (newMember) freshMembers.push(newMember);
    const loaded = await i.sheets.load(freshMembers, i.freeAgentRoleId);
    const plan = buildLeagueAccountReplacementPlan({ guildId: i.guildId, snapshot: loaded.snapshot, oldDiscordId, newDiscordId,
      oldMember, newMember, newNameSheetRow: loaded.sources.names.length + 5 });
    const teamRow = loaded.sources.teams.slice(1).find((row) => String(row[3] ?? '') === plan.rosterBefore.teamRoleId);
    const captainRoleId = String(teamRow?.[9] ?? '').trim();
    const captainRoleIds = loaded.sources.teams.slice(1).filter(row => loaded.snapshot.teams.some(team => team.active && team.teamRoleId === String(row[3] ?? '')))
      .map(row => String(row[9] ?? '').trim()).filter(Boolean);
    if (captainRoleIds.some(id => plan.roles.some(role => role.managedRoleIds.includes(id))))
      throw new LeagueMutationValidationError('Configured captain access overlaps a managed league role. Review role ownership before account replacement.');
    if (captainRoleId) plan.manualReview.push(`Configured captain access role ${captainRoleId} requires manual review; it is not automatically transferred.`);
    await i.discord.assertAccountReplacementRoleOwnership(plan.roles);
    const prepared = await i.sheets.prepareAccountReplacement(loaded, plan);
    const findings = humanizeLeagueAuditIssues(loaded.snapshot, auditLeagueRoster(loaded.snapshot)
      .filter((finding) => [oldDiscordId, newDiscordId].some((id) => finding.includes(` ${id} `))));
    const preservedJobReferences = listActionableLeagueJobs(i.db, i.guildId).filter((job) => job.type === 'repair'
      && job.status === 'BLOCKED_REVIEW' && findings.includes((job.payload as { expectedFinding: string }).expectedFinding))
      .map((job) => job.reference).sort();
    const fingerprint = hash({ guildId: i.guildId, actorUserId, prepared, oldMember: normalizedMember(oldMember), newMember: normalizedMember(newMember) });
    return { plan, prepared, fingerprint, oldMember, newMember: newMember!, preservedJobReferences,
      draftVerification: prepared.draftVerification,
      afterFingerprint: hash({ sources: prepared.after, drafts: prepared.draftAfter, roles: plan.roles.map((role) => [role.discordId, role.after]) }) };
  }

  async preview(actorUserId: string, oldDiscordId: string, newDiscordId: string): Promise<AccountReplacementPreview> {
    const release = await acquireLeagueTransaction(this.input.operationScope, this.input.guildId);
    try {
      const { plan, fingerprint, draftVerification, preservedJobReferences } = await this.inspect(actorUserId, oldDiscordId, newDiscordId);
      return { approvalReference: randomUUID(), plan, fingerprint, draftVerification, preservedJobReferences };
    } finally { release(); }
  }

  async confirm(intent: AccountReplacementIntent): Promise<LeagueJob> {
    const i = this.input;
    await i.authorize(intent.actorUserId);
    if (intent.samePlayerConfirmed !== true || !intent.expectedFingerprint || !/^[0-9a-f-]{36}$/.test(intent.approvalReference ?? ''))
      throw new LeagueMutationValidationError('Confirm the exact account replacement and attest that both accounts belong to the same player.');
    const key = `account-replacement:${intent.oldDiscordId}:${intent.newDiscordId}:${intent.expectedFingerprint}:${intent.approvalReference}`;
    return i.db.transaction(() => {
      const existing = getLeagueJobByDedupe(i.db, i.guildId, key);
      if (existing) return existing;
      assertAccountReplacementAvailable(i.db, i.guildId, intent.oldDiscordId, intent.newDiscordId);
      const pending = i.db.prepare(`SELECT reference FROM league_jobs WHERE guild_id=? AND type='account-replacement'
        AND status IN ('QUEUED','RETRYING','LOADING','VALIDATING','APPLYING','VERIFYING','RECONCILIATION_REQUIRED')
        AND (json_extract(payload_json,'$.oldDiscordId') IN (?,?) OR json_extract(payload_json,'$.newDiscordId') IN (?,?))`).get(
          i.guildId, intent.oldDiscordId, intent.newDiscordId, intent.oldDiscordId, intent.newDiscordId);
      if (pending) throw new LeagueMutationValidationError('A competing account replacement is already queued or awaiting reconciliation.');
      return i.enqueue(intent, key);
    })();
  }

  async record(actorUserId: string, reference: string): Promise<AccountReplacementRecord> {
    await this.input.authorize(actorUserId);
    const record = getAccountReplacement(this.input.db, this.input.guildId, reference);
    if (!record) throw new LeagueMutationValidationError('No account replacement exists in this guild for that reference.');
    return record;
  }

  private async verify(preview: Inspection, manuallyReconciled = false) {
    const i = this.input;
    const sheetEvidence = await i.sheets.verifyAccountReplacement(preview.prepared);
    await i.discord.assertAccountReplacementRoleOwnership(preview.plan.roles);
    const accounts: Array<AccountReplacementMember | null> = [];
    for (const [before, id] of [[preview.oldMember, preview.plan.oldDiscordId], [preview.newMember, preview.plan.newDiscordId]] as const) {
      const fresh = await i.discord.getAccountReplacementMember(id);
      accounts.push(normalizedMember(fresh));
      if (!before) {
        if (fresh && (!manuallyReconciled || fresh.guildId !== i.guildId || fresh.bot
          || fresh.roleIds.some((id) => preview.plan.roles[0]!.managedRoleIds.includes(id))))
          throw new LeagueMutationValidationError('The old account rejoined during replacement. Inspect its roles manually.');
        continue;
      }
      if (!fresh && id === preview.plan.oldDiscordId && manuallyReconciled) continue;
      if (!fresh || fresh.guildId !== i.guildId || fresh.bot
        || (fresh.displayName !== before.displayName && (!manuallyReconciled || id === preview.plan.newDiscordId)))
        throw new LeagueMutationValidationError('An account membership or display name changed during replacement.');
      const role = preview.plan.roles.find((change) => change.discordId === id)!;
      const managed = fresh.roleIds.filter((roleId) => role.managedRoleIds.includes(roleId)).sort();
      const unrelated = (member: AccountReplacementMember) => member.roleIds.filter((roleId) => !role.managedRoleIds.includes(roleId)).sort();
      if (JSON.stringify(managed) !== JSON.stringify(role.after) || (!manuallyReconciled && JSON.stringify(unrelated(before)) !== JSON.stringify(unrelated(fresh))))
        throw new LeagueMutationValidationError('Managed roles or unrelated access do not match the approved replacement.');
    }
    return { ...sheetEvidence, afterFingerprint: preview.afterFingerprint, accounts, verified: true };
  }

  private async inspectRecovery(actorUserId: string, reference: string) {
    const record = await this.record(actorUserId, reference);
    if (record.status !== 'reconciliation_required') throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'This account replacement is not awaiting reconciliation.');
    const preview = record.plan as Inspection;
    let evidence: Awaited<ReturnType<LeagueAccountReplacementService['verify']>>;
    try { evidence = await this.verify(preview, true); }
    catch (error) {
      if (error instanceof LeagueSheetReconciliationRequiredError || error instanceof LeagueMutationValidationError)
        throw new LeagueJobBlockedError('BLOCKED_REVIEW', error.message);
      throw error;
    }
    return { reference, plan: preview.plan, draftVerification: evidence.draftVerification,
      fingerprint: hash({ guildId: this.input.guildId, actorUserId, reference, approvedFingerprint: record.beforeFingerprint, evidence }), evidence };
  }

  async previewRecovery(actorUserId: string, reference: string) {
    const release = await acquireLeagueTransaction(this.input.operationScope, this.input.guildId);
    try {
      const { evidence: _evidence, ...preview } = await this.inspectRecovery(actorUserId, reference);
      return { ...preview, approvalReference: randomUUID() };
    } finally { release(); }
  }

  async confirmRecovery(intent: Omit<AccountReplacementRecoveryIntent, 'mode'>): Promise<LeagueJob> {
    await this.input.authorize(intent.actorUserId);
    if (intent.historyReviewed !== true || !intent.expectedFingerprint || !/^[0-9a-f-]{36}$/.test(intent.approvalReference ?? ''))
      throw new LeagueMutationValidationError('Review the original plan, linkage and preserved history before acknowledging reconciliation.');
    const record = await this.record(intent.actorUserId, intent.reference);
    const key = `account-replacement-recovery:${intent.reference}:${intent.actorUserId}:${intent.expectedFingerprint}:${intent.approvalReference}`;
    const existing = getLeagueJobByDedupe(this.input.db, this.input.guildId, key);
    if (existing) return existing;
    if (record.status !== 'reconciliation_required') throw new LeagueMutationValidationError('This replacement no longer needs reconciliation.');
    return this.input.enqueue({ ...intent, mode: 'reconcile' }, key);
  }

  private async executeRecovery(intent: AccountReplacementRecoveryIntent, phase: (status: LeagueJobStatus) => void) {
    const i = this.input;
    await i.authorize(intent.actorUserId);
    const record = await this.record(intent.actorUserId, intent.reference);
    if (record.status === 'completed') return { reference: intent.reference, manuallyReconciled: true };
    phase('VALIDATING');
    const preview = await this.inspectRecovery(intent.actorUserId, intent.reference);
    if (intent.historyReviewed !== true || preview.fingerprint !== intent.expectedFingerprint)
      throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'Account replacement recovery changed after preview. Review fresh evidence.');
    await i.authorize(intent.actorUserId);
    i.db.transaction(() => {
      transitionAccountReplacement(i.db, i.guildId, intent.reference, 'completed', {
        ...preview.evidence, manuallyReconciled: true, reconciledBy: intent.actorUserId, recoveryFingerprint: preview.fingerprint,
      });
      transitionLeagueJob(i.db, intent.reference, 'COMPLETED', { result: { manuallyReconciled: true } });
    })();
    return { reference: intent.reference, manuallyReconciled: true };
  }

  private async assertWriteAuthority(preview: Inspection, actorUserId: string): Promise<void> {
    const i = this.input;
    await i.authorize(actorUserId);
    for (const [before, id] of [[preview.oldMember, preview.plan.oldDiscordId], [preview.newMember, preview.plan.newDiscordId]] as const) {
      const fresh = await i.discord.getAccountReplacementMember(id);
      if (JSON.stringify(normalizedMember(before)) !== JSON.stringify(normalizedMember(fresh)))
        throw new LeagueMutationValidationError('Account replacement Discord state changed before writing.');
    }
    await i.discord.assertAccountReplacementRoleOwnership(preview.plan.roles);
  }

  async execute(job: LeagueJob, phase: (status: LeagueJobStatus) => void): Promise<unknown> {
    const i = this.input;
    const storedJob = getLeagueJob(i.db, job.reference);
    if (!storedJob || storedJob.guildId !== i.guildId || storedJob.type !== 'account-replacement')
      throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'Account replacement does not belong to this guild worker.');
    const intent = storedJob.payload as AccountReplacementIntent | AccountReplacementRecoveryIntent;
    const completed = getAccountReplacement(i.db, i.guildId, 'mode' in intent ? intent.reference : job.reference)?.status === 'completed';
    if (storedJob.status !== 'LOADING' && !completed)
      throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'Account replacement must be claimed by the canonical worker before execution.');
    const release = await acquireLeagueTransaction(i.operationScope, i.guildId);
    let externalWrite = false;
    try {
      if ('mode' in intent) return await this.executeRecovery(intent, phase);
      await i.authorize(intent.actorUserId);
      const prior = getAccountReplacement(i.db, i.guildId, job.reference);
      if (prior?.status === 'completed') return { reference: job.reference };
      if (prior && prior.status !== 'prepared') throw new LeagueJobBlockedError(prior.status === 'failed' ? 'BLOCKED_REVIEW' : 'RECONCILIATION_REQUIRED', 'Inspect the recorded account replacement; do not replay it.');
      phase('VALIDATING');
      const preview = await this.inspect(intent.actorUserId, intent.oldDiscordId, intent.newDiscordId, job.reference);
      if (intent.samePlayerConfirmed !== true || preview.fingerprint !== intent.expectedFingerprint)
        throw new LeagueMutationValidationError('Account replacement changed after preview. Review and explicitly confirm a fresh preview.');
      await i.sheets.assertAccountReplacementUnchanged(preview.prepared);
      await this.assertWriteAuthority(preview, intent.actorUserId);
      if (!prior) createAccountReplacement(i.db, { reference: job.reference, guildId: i.guildId,
        oldDiscordId: intent.oldDiscordId, newDiscordId: intent.newDiscordId, actorUserId: intent.actorUserId,
        beforeFingerprint: preview.fingerprint, afterFingerprint: preview.afterFingerprint, plan: preview }, preview.preservedJobReferences);
      await i.sheets.applyAccountReplacement(preview.prepared, async (state) => {
        await this.assertWriteAuthority(preview, intent.actorUserId);
        transitionAccountReplacement(i.db, i.guildId, job.reference, state);
        phase('APPLYING');
        externalWrite = true;
      });
      await i.authorize(intent.actorUserId);
      transitionAccountReplacement(i.db, i.guildId, job.reference, 'applying_discord');
      for (const change of preview.plan.roles) if (change.add.length || change.remove.length)
        await i.discord.reconcileAccountReplacementRoles(change);
      transitionAccountReplacement(i.db, i.guildId, job.reference, 'verifying');
      phase('VERIFYING');
      const evidence = await this.verify(preview);
      transitionAccountReplacement(i.db, i.guildId, job.reference, 'completed', evidence);
      return { reference: job.reference, draftVerification: evidence.draftVerification };
    } catch (error) {
      const record = getAccountReplacement(i.db, i.guildId, job.reference);
      if (error instanceof LeagueJobBlockedError && !externalWrite) {
        if (record?.status === 'prepared') transitionAccountReplacement(i.db, i.guildId, job.reference, 'failed', undefined, error.message);
        throw error;
      }
      if (record && record.status !== 'completed' && record.status !== 'failed')
        transitionAccountReplacement(i.db, i.guildId, job.reference, externalWrite ? 'reconciliation_required' : 'failed', undefined, String(error));
      if (externalWrite) throw new LeagueJobBlockedError('RECONCILIATION_REQUIRED', `Account replacement may be partial. Inspect its recorded plan and fresh surfaces; do not retry: ${String(error)}`);
      if (record || error instanceof LeagueMutationValidationError || error instanceof LeagueSheetDriftError)
        throw new LeagueJobBlockedError('BLOCKED_REVIEW', error instanceof Error ? error.message : String(error));
      throw error;
    } finally { release(); }
  }

  async recover(job: LeagueJob): Promise<void> {
    const i = this.input;
    const record = getAccountReplacement(i.db, i.guildId, job.reference);
    if ((job.payload as { mode?: string }).mode === 'reconcile') { transitionLeagueJob(i.db, job.reference, 'QUEUED'); return; }
    if (record?.status === 'completed') { transitionLeagueJob(i.db, job.reference, 'COMPLETED'); return; }
    if ((!record && ['LOADING', 'VALIDATING'].includes(job.status)) || record?.status === 'prepared') {
      transitionLeagueJob(i.db, job.reference, 'QUEUED'); return;
    }
    if (record?.status === 'failed') { transitionLeagueJob(i.db, job.reference, 'BLOCKED_REVIEW', { error: record.error ?? 'Pre-write replacement failed.' }); return; }
    if (record && record.status !== 'reconciliation_required')
      transitionAccountReplacement(i.db, i.guildId, job.reference, 'reconciliation_required', undefined, 'Interrupted external write; inspect before explicit reconciliation.');
    transitionLeagueJob(i.db, job.reference, 'RECONCILIATION_REQUIRED', { error: 'Interrupted account replacement. Do not replay; inspect and explicitly reconcile.' });
  }
}
