import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { dateInLeagueTimezone, leagueTransactionPlanFingerprint, type LeagueDiscordPort } from './leagueTransactions.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { saveLeagueTransactionPreview, getLeaguePreviewApproval, listLeagueTransactions, listLeagueMutationProblems, hasPendingLeagueDeliveries } from '../db/repositories/leagueOperations.js';
import { getLeagueJob, type LeagueJob } from '../db/repositories/leagueJobs.js';
import { reinstatementPolicyExceptions, auditLeagueRoster, LeagueMutationValidationError, type LeagueMutationPlan, type LeagueNameRow, type ReinstatementSource } from '../domain/leagueOperations.js';
import { buildLeagueIntentPlan, parseReinstatementSelection } from './leagueTransactionIntent.js';
import { LeagueSheetDriftError, type LeagueSheetsService, type LoadedLeagueSnapshot, type LeagueTransactionRecord } from './leagueSheets.js';

export const leagueDate = (now = new Date()) => dateInLeagueTimezone(now);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ReinstatementSheets = Pick<LeagueSheetsService, 'readTransactionHistory'>;

export function historicalPlayerChoices(names: LeagueNameRow[], query: string) {
  const search = query.trim().replace(/^<@!?(\d+)>$/, '$1').toLocaleLowerCase();
  const ids = new Set(names.filter(row => `${row.discordId} ${row.currentLeagueName} ${row.knownName}`.toLocaleLowerCase().includes(search)).map(row => row.discordId));
  return [...ids].sort().map(id => {
    const rows = names.filter(row => row.discordId === id);
    const current = rows.find(row => row.nameStatus === 'Current Discord Name') ?? rows[0]!;
    return { name: `${current.currentLeagueName} · ${id} · ${current.leagueStatus}`.slice(0, 100), value: id };
  });
}

export function historicalPlayerIndex(db: Database.Database, guildId: string, names: LeagueNameRow[]): LeagueNameRow[] {
  const result = [...names];
  for (const transaction of listLeagueTransactions(db, guildId)) {
    const plan = (transaction.payload as { plan?: LeagueMutationPlan })?.plan;
    plan?.playerIds.forEach((id, index) => {
      const current = names.find(row => row.discordId === id && row.nameStatus === 'Current Discord Name');
      if (current && plan.players[index]) result.push({ ...current, knownName: plan.players[index]! });
    });
  }
  return result;
}

// Sheets supplies the official date. Neither completion nor announcement time replaces it.
export async function reinstatementSources(db: Database.Database, guildId: string, sheets: ReinstatementSheets): Promise<ReinstatementSource[]> {
  const rows = await sheets.readTransactionHistory();
  return listLeagueTransactions(db, guildId).flatMap(transaction => {
    if (transaction.status !== 'completed' || !['drop', 'departure', 'self-drop'].includes(transaction.kind)) return [];
    const payload = transaction.payload as { plan?: LeagueMutationPlan; record?: LeagueTransactionRecord };
    const plan = payload?.plan;
    if (!plan || plan.kind !== transaction.kind || !plan.playerIds[0] || !plan.teams[0]) return [];
    const matches = rows.filter(row => String(row[0]) === transaction.reference && String(row[6]) === plan.playerIds[0]);
    if (matches.length !== 1) return [];
    const row = matches[0]!;
    const date = String(row[2] ?? '').trim();
    const expectedStatus = transaction.kind === 'drop' ? 'Free Agent' : transaction.kind === 'departure' ? 'Inactive' : 'Suspended - Self-Drop (Current + Next Season)';
    if (String(row[1]) !== transaction.kind || String(row[3]) !== plan.teams[0].division
      || String(row[4]) !== plan.teams[0].franchise || String(row[5]) !== (transaction.kind === 'drop' ? 'Free Agents' : expectedStatus)
      || String(row[8]) !== transaction.actorUserId || String(row[10]) !== 'Completed'
      || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)
      || !Number.isFinite(Date.parse(date))
      || (date.length === 10 && new Date(date).toISOString().slice(0, 10) !== date)) return [];
    const job = getLeagueJob(db, transaction.reference);
    return [{ reference: transaction.reference, playerId: plan.playerIds[0], playerName: String(row[7] ?? plan.players[0]), kind: transaction.kind as ReinstatementSource['kind'],
      effectiveDate: date, processedBy: String(row[11] ?? payload.record?.processedBy ?? transaction.actorUserId),
      processedById: transaction.actorUserId, teamRoleId: plan.teams[0].teamRoleId,
      franchise: plan.teams[0].franchise, division: plan.teams[0].division, resultingStatus: expectedStatus,
      ...(job?.status === 'COMPLETED' && job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(transaction.announcementId ? { announcementId: transaction.announcementId } : {}),
    }];
  });
}

export async function buildVerifiedTransactionIntent(input: {
  db: Database.Database; guildId: string; sheets: Partial<ReinstatementSheets>; selections: string; loaded: LoadedLeagueSnapshot;
}): Promise<LeagueMutationPlan> {
  const selection = parseReinstatementSelection(input.selections);
  if (!selection) return buildLeagueIntentPlan(input.selections, input.loaded.snapshot);
  if (!input.sheets.readTransactionHistory) throw new LeagueMutationValidationError('Historical Sheet verification is unavailable. Ask staff to check the bot before approving.');
  if (hasPendingLeagueDeliveries(input.db, input.guildId) || listLeagueMutationProblems(input.db, input.guildId).length)
    throw new LeagueMutationValidationError('An earlier league action still needs recovery. Resolve that saved action before reinstating a player.');
  const sources = await reinstatementSources(input.db, input.guildId, input.sheets as ReinstatementSheets);
  const source = sources.find(item => item.reference === selection.sourceReference && item.playerId === selection.playerId);
  if (!source) throw new LeagueMutationValidationError('The original completed exit could not be verified against Transaction History. Ask staff to reconcile the source records first.');
  const transactions = listLeagueTransactions(input.db, input.guildId);
  const originalIndex = transactions.findIndex(item => item.reference === source.reference);
  if (transactions.slice(originalIndex + 1).some(item => item.status !== 'failed' && item.kind !== 'rename'
    && (item.payload as { plan?: LeagueMutationPlan })?.plan?.playerIds.includes(selection.playerId)))
    throw new LeagueMutationValidationError('A later roster action already affects this player. Review that action and select the latest applicable exit.');
  const plan = buildLeagueIntentPlan(input.selections, input.loaded.snapshot, source);
  plan.reinstatement!.sourceFingerprint = digest({ sources: input.loaded.sources, source });
  return plan;
}

export function reinstatementPreviewText(plan: LeagueMutationPlan): string {
  const details = plan.reinstatement!;
  const source = details.source;
  const roles = plan.discordRoleChanges[0];
  return [
    '**Reinstatement preview**',
    `${plan.players[0]} · Discord ID: ${plan.playerIds[0]}`,
    `Historical team: ${source.franchise} (${source.division}) · Current status: ${details.currentStatus}`,
    '', '**Original transaction**',
    `${source.kind} · ${source.franchise} → ${source.resultingStatus}`,
    `Processed by ${source.processedBy} (${source.processedById}) · ${source.reference}`,
    '', '**Timing — official Sheet dates**',
    `Original: ${source.effectiveDate} · Proposed reinstatement: ${details.selection.effectiveDate} (league date)`,
    ...(source.completedAt ? [`Separately verified job Completed: ${source.completedAt} (staff advisory only).`] : []),
    '24-hour timing guidance is informational only. Exact elapsed time unavailable. No timing acknowledgement or override is required.',
    '', '**Proposed changes**',
    `${details.currentStatus} → Player · destination: ${plan.teams[0]!.franchise}`,
    roles ? `Discord roles: remove ${roles.remove.map(id => `<@&${id}>`).join(', ') || 'none'}; add ${roles.add.map(id => `<@&${id}>`).join(', ') || 'none'}.` : 'Discord roles: no changes can be made while the player is absent.',
    'Update Current Rosters, Player Name History and the public roster. Keep historical aliases and original draft ownership; top-four highlighting follows player identity.',
    `Append one new linked reinstatement; preserve ${source.reference} and its sanction. Next-season penalties are not waived.`,
    '', '**Staff policy exceptions**',
    ...(reinstatementPolicyExceptions(details).length ? [] : ['No policy exceptions require acknowledgement.']),
    ...reinstatementPolicyExceptions(details).map(item => `${details.selection.overrides.includes(item.id) ? '[Approved]' : '[Review]'} ${item.text}`),
    ...(details.selection.reason ? [`Staff reason: ${details.selection.reason}`] : []),
    '', '**Technical status**',
    ...(details.blockers.length ? [...details.blockers.slice(0, 5), ...(details.blockers.length > 5 ? [`${details.blockers.length - 5} more roster problems need review in league tools.`] : [])] : ['Preview checks passed. Confirmation and the worker recheck identity, permissions, source history, roles and owned Sheet values.']),
    '', 'No roster, role or Sheet changes were made. Confirm saves approval for the worker; completion is reported only after all required steps finish.',
  ].join('\n');
}

export type ReinstatementReview = {
  token: string; guildId: string; actor: string; expiresAt: string;
  payload: { kind: 'picker'; candidates: ReinstatementSource[]; page: number; reason?: string }
    | { kind: 'preview'; selections: string; plan: LeagueMutationPlan; fingerprint: string };
};
type ReviewRow = { token: string; guild_id: string; actor_user_id: string; payload_json: string; expires_at: string; cancelled: number; job_reference: string | null };
export class LeagueReinstatementService {
  constructor(private readonly input: {
    db: Database.Database; guildId: string; sheets: Pick<LeagueSheetsService, 'load' | 'prepare' | 'readTransactionHistory'>;
    discord: LeagueDiscordPort; freeAgentRoleId: string;
    authorize(actor: string): Promise<string>;
    enqueue(payload: { selections: string; actorUserId: string; actorName: string; approvedAt: string; expectedPlanFingerprint: string }, key: string): LeagueJob;
    now?(): Date;
  }) {}
  private now() { return this.input.now?.() ?? new Date(); }
  private review(actor: string, payload: ReinstatementReview['payload']): ReinstatementReview {
    return { token: randomUUID(), guildId: this.input.guildId, actor,
      expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(), payload };
  }
  install(review: ReinstatementReview, previousToken?: string) {
    const { db } = this.input;
    db.transaction(() => {
      if (previousToken) db.prepare('UPDATE league_reinstatement_reviews SET cancelled=1 WHERE token=? AND actor_user_id=? AND job_reference IS NULL').run(previousToken, review.actor);
      db.prepare('INSERT INTO league_reinstatement_reviews(token,guild_id,actor_user_id,payload_json,expires_at) VALUES (?,?,?,?,?)')
        .run(review.token, review.guildId, review.actor, JSON.stringify(review.payload), review.expiresAt);
      if (review.payload.kind === 'preview') saveLeagueTransactionPreview(db, { guildId: review.guildId, actorUserId: review.actor,
        intentKey: review.payload.selections, planFingerprint: review.payload.fingerprint });
    })();
  }
  private async stored(actor: string, token: string) {
    await this.input.authorize(actor);
    const row = this.input.db.prepare('SELECT * FROM league_reinstatement_reviews WHERE token=? AND guild_id=? AND actor_user_id=?')
      .get(token, this.input.guildId, actor) as ReviewRow | undefined;
    if (!row || row.cancelled || (!row.job_reference && row.expires_at <= this.now().toISOString()))
      throw new LeagueMutationValidationError('This review expired or was replaced. Run /transaction reinstate for a fresh private preview.');
    return { row, payload: JSON.parse(row.payload_json) as ReinstatementReview['payload'] };
  }
  async open(actor: string, query: string, transaction?: string, reason?: string): Promise<ReinstatementReview> {
    await this.input.authorize(actor);
    const loaded = await this.input.sheets.load(await this.input.discord.getMembers!(), this.input.freeAgentRoleId);
    const normalized = query.trim().replace(/^<@!?(\d+)>$/, '$1');
    const exactIdentity = loaded.snapshot.names.some(row => row.discordId === normalized);
    const choices = historicalPlayerChoices(historicalPlayerIndex(this.input.db, this.input.guildId, loaded.snapshot.names), normalized);
    const ids = new Set(exactIdentity ? [normalized] : choices.map(item => item.value));
    const sources = (await reinstatementSources(this.input.db, this.input.guildId, this.input.sheets))
      .filter(source => ids.has(source.playerId) && (!transaction || source.reference === transaction.trim()));
    if (!sources.length) throw new LeagueMutationValidationError('No matching completed exit could be verified in the saved actions and Transaction History. Try an old nickname or Discord ID, or ask staff to reconcile the history.');
    if (sources.length > 1) return this.review(actor, { kind: 'picker', candidates: sources, page: 0, reason });
    return this.preview(actor, { version: 1, kind: 'reinstate', playerId: sources[0]!.playerId,
      sourceReference: sources[0]!.reference, teamRoleId: sources[0]!.teamRoleId, returnStatus: 'Player', effectiveDate: leagueDate(this.now()),
      overrides: [], preserveFutureSanction: true, ...(reason ? { reason } : {}) });
  }
  private async preview(actor: string, selection: import('../domain/leagueOperations.js').ReinstatementSelection): Promise<ReinstatementReview> {
    const { db, guildId, sheets, discord, freeAgentRoleId } = this.input;
    const selections = JSON.stringify(selection);
    const loaded = await sheets.load(await discord.getMembers!(), freeAgentRoleId);
    const plan = await buildVerifiedTransactionIntent({ db, guildId, sheets, selections, loaded });
    const details = plan.reinstatement!;
    const auditIssues = auditLeagueRoster(loaded.snapshot, { allowReinstatementMemberId: selection.playerId });
    if (auditIssues.length) console.error('Reinstatement preview roster audit failed', { guildId, playerId: selection.playerId, issues: auditIssues });
    details.blockers.push(...humanizeLeagueAuditIssues(loaded.snapshot, auditIssues));
    try {
      sheets.prepare(loaded, plan);
      if (!details.blockers.length) {
        if (!discord.validateReinstatementRoles) throw new Error('Role ownership verification is unavailable. Ask staff to check the bot.');
        await discord.validateReinstatementRoles(plan, loaded.snapshot);
      }
    } catch (error) {
      console.error('Reinstatement preview technical verification failed', error);
      details.blockers.push(error instanceof LeagueMutationValidationError || error instanceof LeagueSheetDriftError ? error.message : 'The Sheet destination or Discord roles could not be verified. Ask staff to check the destination and Rat’s permissions.');
    }
    await this.input.authorize(actor);
    // Blockers only describe the read-only view. Successful execution rebuilds the unadorned domain plan.
    return this.review(actor, { kind: 'preview', selections, plan,
      fingerprint: leagueTransactionPlanFingerprint({ ...plan, reinstatement: { ...details, blockers: [] } }) });
  }
  async choose(actor: string, token: string, value: string): Promise<ReinstatementReview> {
    const { row, payload } = await this.stored(actor, token);
    if (row.job_reference || payload.kind !== 'picker') throw new LeagueMutationValidationError('This selection is no longer available. Open a fresh review.');
    const source = payload.candidates[Number(value)];
    if (!source || !Number.isInteger(Number(value)) || !payload.candidates.slice(payload.page * 25, payload.page * 25 + 25).includes(source))
      throw new LeagueMutationValidationError('Choose an original action from the current list.');
    return this.preview(actor, { version: 1, kind: 'reinstate', playerId: source.playerId, sourceReference: source.reference,
      teamRoleId: source.teamRoleId, returnStatus: 'Player', effectiveDate: leagueDate(this.now()), overrides: [], preserveFutureSanction: true,
      ...(payload.reason ? { reason: payload.reason } : {}) });
  }
  async page(actor: string, token: string, delta: number) {
    const { row, payload } = await this.stored(actor, token);
    if (row.job_reference || payload.kind !== 'picker') throw new LeagueMutationValidationError('Open a fresh historical-player search.');
    const page = payload.page + delta;
    if (page < 0 || page * 25 >= payload.candidates.length) throw new LeagueMutationValidationError('That page is unavailable.');
    return this.review(actor, { ...payload, page });
  }
  async exceptions(actor: string, token: string, overrides: string[]) {
    const { row, payload } = await this.stored(actor, token);
    if (row.job_reference || payload.kind !== 'preview') throw new LeagueMutationValidationError('Open a fresh preview before choosing exceptions.');
    if (new Set(overrides).size !== overrides.length || overrides.some(id => !reinstatementPolicyExceptions(payload.plan.reinstatement!).some(item => item.id === id)))
      throw new LeagueMutationValidationError('Choose only the advisories shown in this preview.');
    return this.preview(actor, { ...parseReinstatementSelection(payload.selections)!, overrides: [...overrides].sort() });
  }
  async cancel(actor: string, token: string) {
    const { row } = await this.stored(actor, token);
    if (row.job_reference) throw new LeagueMutationValidationError('This approval is already saved. Check its reference in league tools; it cannot be cancelled here.');
    this.input.db.prepare('UPDATE league_reinstatement_reviews SET cancelled=1 WHERE token=?').run(token);
  }
  async confirm(actor: string, token: string): Promise<LeagueJob> {
    const { row, payload } = await this.stored(actor, token);
    if (row.job_reference) return getLeagueJob(this.input.db, row.job_reference)!;
    if (payload.kind !== 'preview') throw new LeagueMutationValidationError('Select an original action and review it before confirming.');
    const details = payload.plan.reinstatement!;
    if (details.blockers.length) throw new LeagueMutationValidationError(details.blockers.join(' '));
    if (reinstatementPolicyExceptions(details).some(item => !details.selection.overrides.includes(item.id)))
      throw new LeagueMutationValidationError('Choose each listed staff advisory you approve, then confirm.');
    const fresh = await this.preview(actor, details.selection);
    if (fresh.payload.kind !== 'preview' || fresh.payload.plan.reinstatement!.blockers.length || fresh.payload.fingerprint !== payload.fingerprint)
      throw new LeagueMutationValidationError('The roster, source history, roles or Sheet values changed. Run /transaction reinstate and review a new preview. No changes were made.');
    if (details.selection.effectiveDate !== leagueDate(this.now())) throw new LeagueMutationValidationError('The league date changed. Request a fresh preview.');
    const actorName = await this.input.authorize(actor);
    // No await between deduped enqueue and saving the result: duplicate clicks share one durable job.
    const current = this.input.db.prepare('SELECT cancelled,job_reference FROM league_reinstatement_reviews WHERE token=?').get(token) as ReviewRow;
    if (current.cancelled) throw new LeagueMutationValidationError('This preview was replaced. Open the latest review.');
    if (current.job_reference) return getLeagueJob(this.input.db, current.job_reference)!;
    const approval = getLeaguePreviewApproval(this.input.db, this.input.guildId, actor, payload.selections);
    if (!approval) throw new LeagueMutationValidationError('The saved approval is unavailable. Request a new preview.');
    const job = this.input.enqueue({ selections: payload.selections, actorUserId: actor, actorName, approvedAt: this.now().toISOString(), expectedPlanFingerprint: payload.fingerprint },
      `reinstate:${actor}:${token}`);
    this.input.db.prepare('UPDATE league_reinstatement_reviews SET job_reference=? WHERE token=?').run(job.reference, token);
    return job;
  }
}
