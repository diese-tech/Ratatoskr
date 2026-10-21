import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import { enqueueLeagueJob, getLeagueJob, transitionLeagueJob, type LeagueJobType } from '../db/repositories/leagueJobs.js';
import { replaceLeagueFindings, replaceFullLeagueFindings } from '../db/repositories/leagueVerifiedState.js';
import { beginDirtyLeagueAudit } from '../db/repositories/leagueAudits.js';
import { auditLeagueRoster } from '../domain/leagueOperations.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { LeagueAccountReplacementService } from './leagueAccountReplacement.js';
import { LeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { buildLeagueIntentPlan } from './leagueTransactionIntent.js';
import { previewLeagueAuditResolution } from './leagueAuditResolution.js';
import { LeagueOpsReviewService, leagueOpsText } from './leagueOpsReview.js';
import { createLeagueAuditRepair, markLeagueAuditRepairReconciliationRequired } from '../db/repositories/leagueAuditRepairs.js';
import { executeLeagueAuditRepair } from './leagueAuditResolution.js';

export async function leagueOpsReviewFixture() {
  const db = openDatabase(':memory:');
  const sources = accountReplacementSources();
  let allowed = true;
  const authorize = async () => { if (!allowed) throw Error('Permission revoked'); return 'Admin'; };
  let worker: LeagueJobWorker;
  const replacement = new LeagueAccountReplacementService({ ...sources, db, operationScope: db, guildId: 'g', freeAgentRoleId: 'fa',
    authorize: async () => { await authorize(); }, enqueue: (payload, key) => worker.enqueue('account-replacement', payload, key) });
  const idle: LeagueJobHandler = async () => {};
  const handlers = Object.fromEntries(['transaction', 'repair', 'targeted', 'panel', 'dirty', 'audit', 'heartbeat', 'account-replacement']
    .map(type => [type, idle])) as Record<LeagueJobType, LeagueJobHandler>;
  handlers['account-replacement'] = (job, phase) => replacement.execute(job, phase);
  worker = new LeagueJobWorker(db, 'g', handlers, job => replacement.recover(job));
  worker.stop();
  const load = () => sources.sheets.load([...sources.members.values()], 'fa');
  const service = new LeagueOpsReviewService({ db, scope: db, guildId: 'g', worker, replacement, authorize,
    previewTransaction: async selections => buildLeagueIntentPlan(selections, (await load()).snapshot),
    previewRepair: async (finding, action) => previewLeagueAuditResolution(await load(), finding, action) });
  const recheck = async (reference = 'audit') => {
    const loaded = await load();
    const diagnostics = auditLeagueRoster(loaded.snapshot);
    const findings = humanizeLeagueAuditIssues(loaded.snapshot, diagnostics);
    replaceFullLeagueFindings(db, 'g', loaded.snapshot, diagnostics, findings, new Date());
    beginDirtyLeagueAudit(db, { guildId: 'g', runReference: reference, result: 'dirty', trigger: 'scheduled', findings, runAt: new Date().toISOString() });
  };
  await recheck();
  return { ...sources, db, service, worker, replacement, recheck, deny: () => { allowed = false; },
    close: () => { worker.stop(); db.close(); } };
}

test('private operations preserve original repair errors, distinguish actions and reject revoked access', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const error = 'This player does not have exactly one current name record. Resolve Player Name History first.';
    const repair = enqueueLeagueJob(f.db, { guildId: 'g', type: 'repair', dedupeKey: 'old-repair',
      payload: { action: 'repair-roles', expectedFinding: 'One — Discord team does not match', actorName: 'Dolo' } });
    transitionLeagueJob(f.db, repair.reference, 'BLOCKED_REVIEW', { error });
    const result = await f.service.snapshot('admin');
    assert.equal(result.operations[0]?.error, error);
    assert.equal(result.operations[0]?.action, 'repair-roles');
    assert.equal(result.operations[0]?.canRepreview, false);
    assert.match(result.operations[0]!.next, /Roster problems/);
    assert.ok(result.issues.some(issue => issue.oldDiscordId === 'one'));
    f.deny();
    await assert.rejects(() => f.service.snapshot('admin'), /revoked/);
    await assert.rejects(() => f.service.previewTransaction('admin', repair.reference), /revoked/);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('fresh transaction previews retain selections, dedupe confirmation and never replay a recorded mutation', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const selections = JSON.stringify(['trade', 'one', 'two']);
    const original = enqueueLeagueJob(f.db, { guildId: 'g', type: 'transaction', dedupeKey: 'old-trade',
      payload: { selections, actorUserId: 'admin', actorName: 'Admin', expectedPlanFingerprint: 'old' } });
    transitionLeagueJob(f.db, original.reference, 'BLOCKED_REVIEW', { error: 'Roster audit failed. No changes were made.' });
    const preview = await f.service.previewTransaction('admin', original.reference);
    assert.equal(preview.selections, selections);
    assert.equal(f.gateway.writes.length, 0);
    const job = await f.service.confirmTransaction('admin', preview);
    assert.equal((await f.service.confirmTransaction('admin', preview)).reference, job.reference);
    assert.equal(getLeagueJob(f.db, original.reference)?.status, 'BLOCKED_REVIEW');
    const other = enqueueLeagueJob(f.db, { guildId: 'other', type: 'transaction', dedupeKey: 'other', payload: { selections } });
    transitionLeagueJob(f.db, other.reference, 'BLOCKED_REVIEW');
    await assert.rejects(() => f.service.previewTransaction('admin', other.reference), /pre-write/);
    f.db.prepare('INSERT INTO league_transactions(reference,guild_id,kind,actor_user_id,payload_json,status) VALUES(?,?,?,?,?,?)')
      .run(original.reference, 'g', 'trade', 'admin', '{}', 'reconciliation_required');
    await assert.rejects(() => f.service.previewTransaction('admin', original.reference), /pre-write/);
    assert.equal((await f.service.confirmTransaction('admin', preview)).reference, job.reference);
    await assert.rejects(() => f.service.confirmTransaction('admin', { ...preview, approval: 'another-approval' }), /original operation changed/i);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('a retry completed by another administrator supersedes the original trade preview', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const selections = JSON.stringify(['trade', 'one', 'two']);
    const original = enqueueLeagueJob(f.db, { guildId: 'g', type: 'transaction', dedupeKey: 'original-other-admin',
      payload: { selections, actorUserId: 'original-admin', expectedPlanFingerprint: 'old' } });
    transitionLeagueJob(f.db, original.reference, 'BLOCKED_REVIEW');
    const preview = await f.service.previewTransaction('current-admin', original.reference);
    const retry = await f.service.confirmTransaction('current-admin', preview);
    transitionLeagueJob(f.db, retry.reference, 'COMPLETED');
    await assert.rejects(() => f.service.previewTransaction('current-admin', original.reference), /pre-write/);
    assert.equal((await f.service.confirmTransaction('current-admin', preview)).reference, retry.reference);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('account replacement requires a current absent-account issue and exact explicit attestation', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const issue = (await f.service.snapshot('admin')).issues.find(issue => issue.oldDiscordId === 'one')!;
    await assert.rejects(() => f.service.previewReplacement('admin', issue.key, 'two', 'new'), /problem changed/);
    const preview = await f.service.previewReplacement('admin', issue.key, 'one', 'new');
    assert.equal(f.gateway.writes.length, 0);
    await assert.rejects(() => f.service.confirmReplacement('admin', preview, false), /both Discord accounts belong to the same player/i);
    const job = await f.service.confirmReplacement('admin', preview, true);
    assert.equal((await f.service.confirmReplacement('admin', preview, true)).reference, job.reference);
    assert.equal(job.type, 'account-replacement');
    f.deny();
    await assert.rejects(() => f.service.confirmReplacement('admin', preview, true), /revoked/);
  } finally { f.close(); }
});

test('equivalent repair confirmations survive audit reference changes without creating duplicate jobs', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    f.members.get('two')!.displayName = 'Two New';
    await f.recheck('first-audit');
    const issue = (await f.service.snapshot('admin')).issues.find(issue => issue.finding.includes('Two New'))!;
    const preview = await f.service.previewRepair('admin', issue.key);
    const job = await f.service.confirmRepair('admin', preview);
    await f.recheck('later-audit');
    const second = await f.service.previewRepair('admin', issue.key);
    assert.equal(second.fingerprint, preview.fingerprint);
    assert.equal((await f.service.confirmRepair('admin', second)).reference, job.reference);
    assert.equal((f.db.prepare('SELECT count(*) n FROM league_jobs WHERE type=?').get('repair') as { n: number }).n, 1);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('repair approval aliases stay idempotent after a safe block, while fresh review allows explicit recovery', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    f.members.get('two')!.displayName = 'Two New';
    await f.recheck();
    const issue = (await f.service.snapshot('admin')).issues.find(issue => issue.finding.includes('Two New'))!;
    const first = await f.service.previewRepair('admin', issue.key);
    const original = await f.service.confirmRepair('admin', first);
    const equivalent = await f.service.previewRepair('admin', issue.key);
    assert.equal((await f.service.confirmRepair('admin', equivalent)).reference, original.reference);
    transitionLeagueJob(f.db, original.reference, 'BLOCKED_REVIEW', { error: 'Authorization revoked before writing' });
    assert.equal((await f.service.confirmRepair('admin', first)).reference, original.reference);
    assert.equal((await f.service.confirmRepair('admin', equivalent)).reference, original.reference);
    const fresh = await f.service.previewRepair('admin', issue.key);
    const retry = await f.service.confirmRepair('admin', fresh);
    assert.notEqual(retry.reference, original.reference);
    assert.equal((await f.service.confirmRepair('admin', fresh)).reference, retry.reference);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('a recurring repaired role finding receives fresh work while its old approval stays idempotent', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const correctRoles = [...f.members.get('two')!.roleIds];
    f.members.get('two')!.roleIds = ['division'];
    await f.recheck();
    const issue = (await f.service.snapshot('admin')).issues.find(item => item.finding.includes('Two') && item.finding.includes('team role'))!;
    assert.ok(issue);
    const first = await f.service.previewRepair('admin', issue.key);
    const original = await f.service.confirmRepair('admin', first);
    await executeLeagueAuditRepair({ db: f.db, operationScope: f.db, guildId: 'g', auditReference: 'audit', actorUserId: 'admin',
      actorName: 'Admin', now: new Date(), expectedFinding: first.finding, action: first.action, expectedRepairFingerprint: first.fingerprint,
      freeAgentRoleId: 'fa', jobReference: original.reference, members: { getMembers: async () => [...f.members.values()] }, sheets: f.sheets,
      discord: { validateDisplayName: async () => {}, reconcileManagedRoles: async () => { f.members.get('two')!.roleIds = correctRoles; } } });
    transitionLeagueJob(f.db, original.reference, 'COMPLETED');
    await f.recheck();
    f.members.get('two')!.roleIds = ['division'];
    await f.recheck();
    const second = await f.service.previewRepair('admin', issue.key);
    assert.equal(second.fingerprint, first.fingerprint);
    const recurring = await f.service.confirmRepair('admin', second);
    assert.notEqual(recurring.reference, original.reference);
    assert.equal(recurring.status, 'QUEUED');
    assert.equal((await f.service.confirmRepair('admin', second)).reference, recurring.reference);
    assert.equal((await f.service.confirmRepair('admin', first)).reference, original.reference);
  } finally { f.close(); }
});

test('completed references and interrupted legacy repairs remain inspectable within their guild', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    const completed = enqueueLeagueJob(f.db, { guildId: 'g', type: 'transaction', dedupeKey: 'finished', payload: { selections: JSON.stringify(['trade', 'one', 'two']) } });
    transitionLeagueJob(f.db, completed.reference, 'COMPLETED');
    assert.equal((await f.service.operationDetail('admin', completed.reference)).status, 'COMPLETED');
    createLeagueAuditRepair(f.db, { reference: 'YSL-AUD-FIX-LEGACY', guildId: 'g', auditReference: 'old', actorUserId: 'admin', finding: 'Original finding', action: 'repair-roles' });
    markLeagueAuditRepairReconciliationRequired(f.db, 'YSL-AUD-FIX-LEGACY', 'Original role response lost');
    const legacy = (await f.service.snapshot('admin')).operations.find(operation => operation.reference === 'YSL-AUD-FIX-LEGACY');
    assert.equal(legacy?.canRecover, true);
    assert.equal(legacy?.error, 'Original role response lost');
    await assert.rejects(() => f.service.operationDetail('admin', 'unknown'), /not found in this server/i);
  } finally { f.close(); }
});

test('repair execution rejects changed sheet proof before creating any external-write record', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    f.members.get('two')!.displayName = 'Two New';
    const loaded = await f.sheets.load([...f.members.values()], 'fa');
    const finding = humanizeLeagueAuditIssues(loaded.snapshot, auditLeagueRoster(loaded.snapshot)).find(finding => finding.includes('Two New'))!;
    const preview = previewLeagueAuditResolution(loaded, finding, 'use-discord-name');
    f.gateway.rows('admin', 'Current Rosters')[6]![8] = 'New staff note';
    await assert.rejects(() => executeLeagueAuditRepair({ db: f.db, operationScope: f.db, guildId: 'g', auditReference: 'audit',
      actorUserId: 'admin', actorName: 'Admin', now: new Date(), expectedFinding: finding, action: 'use-discord-name', expectedRepairFingerprint: preview.fingerprint,
      freeAgentRoleId: 'fa', members: { getMembers: async () => [...f.members.values()] }, sheets: f.sheets,
      discord: { validateDisplayName: async () => {}, reconcileManagedRoles: async () => assert.fail('No role write is allowed') } }), /changed since this review page opened/i);
    assert.equal(f.gateway.writes.length, 0);
    assert.equal((f.db.prepare('SELECT count(*) n FROM league_audit_repairs').get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test('previously hidden role findings can be previewed, confirmed and repaired without touching unrelated roles or sheets', async () => {
  for (const roles of [['a', 'b', 'division', 'unmanaged'], ['b', 'division', 'fa', 'unmanaged']]) {
    const f = await leagueOpsReviewFixture();
    try {
      f.members.get('two')!.roleIds = [...roles];
      await f.recheck();
      const issue = (await f.service.snapshot('admin')).issues.find(item =>
        item.finding.includes('Two has multiple team roles') || item.finding.includes('Two is rostered on'))!;
      assert.ok(issue);
      const preview = await f.service.previewRepair('admin', issue.key);
      assert.equal(preview.action, 'repair-roles');
      assert.deepEqual(f.members.get('two')!.roleIds, roles);
      const job = await f.service.confirmRepair('admin', preview);
      assert.equal(job.type, 'repair');
      assert.deepEqual(f.members.get('two')!.roleIds, roles);
      await executeLeagueAuditRepair({ db: f.db, operationScope: f.db, guildId: 'g', auditReference: 'audit',
        actorUserId: 'admin', actorName: 'Admin', now: new Date(), freeAgentRoleId: 'fa',
        expectedFinding: preview.finding, action: preview.action, expectedRepairFingerprint: preview.fingerprint,
        jobReference: job.reference, sheets: f.sheets, members: { getMembers: async () => [...f.members.values()] },
        discord: { validateDisplayName: async () => {}, reconcileManagedRoles: async change => {
          const member = f.members.get(change.discordId)!;
          member.roleIds = member.roleIds.filter(id => !change.remove.includes(id)).concat(change.add);
        } } });
      await f.recheck();
      assert.deepEqual(f.members.get('two')!.roleIds.sort(), ['b', 'division', 'unmanaged']);
      assert.ok(!(await f.service.snapshot('admin')).issues.some(item => item.finding === issue.finding));
      assert.equal(f.gateway.writes.length, 0);
    } finally { f.close(); }
  }
});

test('private error text redacts credentials and escapes mentions/formatting', () => {
  const previous = process.env.PRIVATE_TEST_TOKEN;
  process.env.PRIVATE_TEST_TOKEN = 'sensitive-test-value';
  try {
    const value = leagueOpsText('Authorization: Bot another-secret; sensitive-test-value **unsafe**');
    assert.doesNotMatch(value, /another-secret|sensitive-test-value/);
    assert.match(value, /REDACTED/);
    assert.ok(value.includes('\\*\\*unsafe\\*\\*'));
  } finally { if (previous === undefined) delete process.env.PRIVATE_TEST_TOKEN; else process.env.PRIVATE_TEST_TOKEN = previous; }
  const credentialBefore = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    const key = 'synthetic-private-key\nsecond-line';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ private_key: key });
    assert.doesNotMatch(leagueOpsText(key + ' / ' + JSON.stringify(key).slice(1, -1)), /synthetic-private-key|second-line/);
  } finally { if (credentialBefore === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = credentialBefore; }
});


test('private check details retain exact sheet repair guidance, draft counts and check times', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    replaceLeagueFindings(f.db, 'g', 'connection', ['Player Name History row 234: move the existing values one column left.'], new Date());
    replaceLeagueFindings(f.db, 'g', 'feature:draft-picks', ['Draft Picks is missing. Ask an admin to check its setup. Draft picks checked: 2026-10-21T12:00:00Z'], new Date());
    const snapshot = await f.service.snapshot('admin');
    const details = snapshot.checkDetails!.join('\n');
    assert.match(details, /Player Name History row 234.*move the existing values one column left/);
    assert.match(details, /Draft Picks is missing/);
    assert.match(details, /8:00 AM EDT/);
    assert.match(details, /Last full roster check/);
    assert.match(details, /Panel reference/);
    assert.equal(snapshot.draftNeedsAttention, true);
    assert.equal(f.gateway.writes.length, 0);
    f.deny();
    await assert.rejects(() => f.service.snapshot('admin'), /revoked/);
  } finally { f.close(); }
});


test('unfinished private inventory includes canonical work at every active phase', async () => {
  const f = await leagueOpsReviewFixture();
  try {
    for (const status of ['QUEUED', 'LOADING', 'VALIDATING', 'APPLYING', 'VERIFYING', 'RETRYING'] as const) {
      const job = enqueueLeagueJob(f.db, { guildId: 'g', type: 'transaction', dedupeKey: status, payload: {} });
      if (status !== 'QUEUED') transitionLeagueJob(f.db, job.reference, status);
      assert.ok((await f.service.snapshot('admin')).operations.some(operation => operation.reference === job.reference && operation.status === status));
    }
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});
