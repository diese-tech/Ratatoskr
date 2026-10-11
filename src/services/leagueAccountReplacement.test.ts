import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/client.js';
import { dismissResolvedRepairReviews, enqueueLeagueJob, getLeagueJob, listActionableLeagueJobs, transitionLeagueJob, type LeagueJobType } from '../db/repositories/leagueJobs.js';
import { LeagueJobBlockedError, LeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import { LeagueAccountReplacementService } from './leagueAccountReplacement.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { executeLeagueTransaction } from './leagueTransactions.js';
import { draftPickHistoricalIds } from './draftPicks.js';

function fixture(db = openDatabase(':memory:'), sources = accountReplacementSources()) {
  let allowed = true;
  let worker: LeagueJobWorker;
  const service = new LeagueAccountReplacementService({ ...sources, db, operationScope: db, guildId: 'g', freeAgentRoleId: 'fa',
    authorize: async () => { if (!allowed) throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'ADMIN access revoked'); },
    enqueue: (payload, key) => worker.enqueue('account-replacement', payload, key) });
  const noOp: LeagueJobHandler = async () => {};
  const handlers: Record<LeagueJobType, LeagueJobHandler> = { transaction: noOp, repair: noOp, targeted: noOp,
    panel: noOp, dirty: noOp, audit: noOp, heartbeat: noOp,
    'account-replacement': (job, phase) => service.execute(job, phase) };
  worker = new LeagueJobWorker(db, 'g', handlers, (job) => service.recover(job));
  worker.stop();
  return { ...sources, sources, db, service, worker, deny: () => { allowed = false; } };
}

async function settle(f: ReturnType<typeof fixture>, reference: string) {
  f.worker.start();
  for (let i = 0; i < 100; i++) {
    const job = getLeagueJob(f.db, reference)!;
    if (['COMPLETED', 'BLOCKED_REVIEW', 'RECONCILIATION_REQUIRED', 'FAILED'].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('Replacement did not settle');
}

test('read-only account preview and duplicate explicit confirmations execute once through the canonical worker', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    assert.equal(f.gateway.writes.length, 0);
    assert.equal(preview.plan.rosterAfter.rosterStatus, 'Captain');
    assert.ok(preview.plan.manualReview.some((item) => item.includes('captain-access')));
    const intent = { actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true as const };
    const job = await f.service.confirm(intent);
    assert.equal((await f.service.confirm(intent)).reference, job.reference);
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
    const record = f.service.record('admin', job.reference);
    assert.equal((await record).status, 'completed');
    assert.equal((await f.service.confirm(intent)).reference, job.reference);
    assert.equal(f.gateway.writes.length, 1);
    assert.equal(f.gateway.appends, 0);
  } finally { f.worker.stop(); f.db.close(); }
});

test('captain access overlapping managed roles blocks replacement before any writes', async () => {
  for (const role of ['a', 'division', 'fa']) {
    const f = fixture();
    try {
      f.gateway.rows('admin', 'League Teams')[5]![9] = role;
      await assert.rejects(() => f.service.preview('admin', 'one', 'new'), /captain access overlaps/i);
      assert.equal(f.gateway.writes.length, 0);
      assert.equal(f.roleWrites, 0);
    } finally { f.worker.stop(); f.db.close(); }
  }
});

test('recovery allows unrelated notes while requiring fresh approval and exact replacement cells', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    f.gateway.rows('admin', 'Current Rosters')[6]![8] = 'unrelated staff note';
    const recovery = await f.service.previewRecovery('admin', job.reference);
    f.gateway.rows('admin', 'Current Rosters')[6]![8] = 'another staff note';
    const stale = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, stale.reference)).status, 'BLOCKED_REVIEW');
    f.gateway.rows('admin', 'Current Rosters')[5]![5] = 'wrong identity';
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /read-back/i);
    f.gateway.rows('admin', 'Current Rosters')[5]![5] = 'One';
    const fresh = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: fresh.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, 1);
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[6]![8], 'another staff note');
  } finally { f.worker.stop(); f.db.close(); }
});

test('an unclaimed queue intent cannot bypass the canonical worker through the execution interface', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    await assert.rejects(() => f.service.execute(job, () => {}), /claimed.*worker/i);
    assert.equal(f.gateway.writes.length, 0);
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
  } finally { f.worker.stop(); f.db.close(); }
});

test('original blocked repair jobs remain actionable evidence after successful replacement and clean audits', async () => {
  const f = fixture();
  try {
    const finding = 'One — Discord team: Dream Walkers VD; Current Rosters team: none. Make them match.';
    const originals = [0, 1, 2].map((index) => {
      const job = enqueueLeagueJob(f.db, { guildId: 'g', type: 'repair', dedupeKey: `original:${index}`,
        payload: { action: 'repair-roles', expectedFinding: finding } });
      transitionLeagueJob(f.db, job.reference, 'BLOCKED_REVIEW', { error: 'Missing current name' });
      return job.reference;
    });
    const preview = await f.service.preview('admin', 'one', 'new');
    assert.deepEqual(preview.preservedJobReferences, [...originals].sort());
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
    dismissResolvedRepairReviews(f.db, 'g', []);
    assert.deepEqual(listActionableLeagueJobs(f.db, 'g').map((job) => job.reference).sort(), [...originals].sort());
  } finally { f.worker.stop(); f.db.close(); }
});

test('partial Discord failure is never replayed, and recovery requires fresh matching sources and history acknowledgement', async () => {
  const f = fixture();
  try {
    f.members.get('new')!.roleIds = ['fa', 'unmanaged'];
    const apply = f.discord.reconcileAccountReplacementRoles;
    f.discord.reconcileAccountReplacementRoles = async (change) => { await apply(change); throw Error('Discord response lost'); };
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    const recovery = await f.service.previewRecovery('admin', job.reference);
    await assert.rejects(() => f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: recovery.fingerprint, historyReviewed: false as never }), /history/i);
    f.members.get('new')!.roleIds.push('new-manual-access');
    const stale = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: recovery.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, stale.reference)).status, 'BLOCKED_REVIEW');
    assert.equal((await f.service.record('admin', job.reference)).status, 'reconciliation_required');
    const current = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: current.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('changed previews, target membership and revoked authorization stop queued replacements before any write', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.gateway.rows('admin', 'Current Rosters')[5]![8] = 'manual edit'; },
    (f: ReturnType<typeof fixture>) => { f.members.get('new')!.displayName = 'Changed'; },
    (f: ReturnType<typeof fixture>) => { f.members.get('new')!.bot = true; },
    (f: ReturnType<typeof fixture>) => { f.members.delete('new'); },
    (f: ReturnType<typeof fixture>) => f.deny(),
  ]) {
    const f = fixture();
    try {
      const preview = await f.service.preview('admin', 'one', 'new');
      const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
        expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
      change(f);
      assert.equal((await settle(f, job.reference)).status, 'BLOCKED_REVIEW');
      assert.equal(f.gateway.writes.length, 0);
    } finally { f.worker.stop(); f.db.close(); }
  }
});

test('authorization and Discord identity are rechecked after the final sheet proof reads', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.deny(),
    (f: ReturnType<typeof fixture>) => { f.members.get('new')!.bot = true; },
  ]) {
    const f = fixture();
    try {
      const preview = await f.service.preview('admin', 'one', 'new');
      const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
      let rosterReads = 0;
      f.gateway.beforeRead = (workbook, range) => {
        if (workbook === 'admin' && range.includes('Current Rosters') && ++rosterReads === 3) change(f);
      };
      assert.equal((await settle(f, job.reference)).status, 'BLOCKED_REVIEW');
      assert.equal(f.gateway.writes.length, 0);
    } finally { f.worker.stop(); f.db.close(); }
  }
});

test('competing actors cannot queue different approvals for the same replacement or steal its target', async () => {
  const f = fixture();
  try {
    const one = await f.service.preview('admin', 'one', 'new');
    const two = await f.service.preview('other-admin', 'one', 'new');
    await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: one.fingerprint, samePlayerConfirmed: true });
    await assert.rejects(() => f.service.confirm({ actorUserId: 'other-admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: two.fingerprint, samePlayerConfirmed: true }), /competing/i);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.worker.stop(); f.db.close(); }
});

test('ambiguous Admin writes retain evidence, stop automatic replay and require explicit reconciliation', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    assert.equal((await f.service.record('admin', job.reference)).status, 'reconciliation_required');
    const writes = f.gateway.writes.length;
    f.worker.stop();
    await f.worker.recover();
    f.worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.gateway.writes.length, writes);
    const recovery = await f.service.previewRecovery('admin', job.reference);
    const acknowledgement = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: recovery.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, acknowledgement.reference)).status, 'COMPLETED');
    assert.equal((await f.service.record('admin', job.reference)).status, 'completed');
    assert.equal(getLeagueJob(f.db, job.reference)?.status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, writes);
  } finally { f.worker.stop(); f.db.close(); }
});

test('a possibly partial replacement blocks further canonical mutations even when its current surfaces look clean', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    await assert.rejects(() => executeLeagueTransaction({ db: f.db, operationScope: f.db, guildId: 'g', actorUserId: 'admin',
      actorName: 'Admin', freeAgentRoleId: 'fa', now: new Date(), sheets: f.sheets, discord: {} as never,
      buildPlan: () => assert.fail('Must not plan another mutation before replacement reconciliation') }), /account replacement.*reconciliation/i);
    f.members.set('third', { guildId: 'g', bot: false, discordId: 'third', displayName: 'Two', roleIds: [] });
    await assert.rejects(() => f.service.preview('admin', 'two', 'third'), /account replacement.*reconciliation/i);
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('SQLite reopen resumes pre-write intent and quarantines a hard interruption after durable write evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'league-replacement-'));
  const path = join(directory, 'test.db');
  let f = fixture(openDatabase(path));
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    transitionLeagueJob(f.db, job.reference, 'VALIDATING');
    const sources = f.sources;
    f.worker.stop(); f.db.close();
    f = fixture(openDatabase(path), sources);
    await f.worker.recover();
    assert.equal(getLeagueJob(f.db, job.reference)?.status, 'QUEUED');
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    // Rehearse the persisted state of a process killed inside its external write.
    f.db.prepare("UPDATE league_account_replacements SET status='applying_admin' WHERE reference=?").run(job.reference);
    transitionLeagueJob(f.db, job.reference, 'APPLYING');
    f.worker.stop(); f.db.close();
    f = fixture(openDatabase(path), sources);
    await f.worker.recover();
    assert.equal(getLeagueJob(f.db, job.reference)?.status, 'RECONCILIATION_REQUIRED');
    assert.equal((await f.service.record('admin', job.reference)).status, 'reconciliation_required');
    f.worker.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.gateway.writes.length, 1);
    const recovery = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
  } finally {
    f.worker.stop(); f.db.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'league-replacement-'))));
    rmSync(directory, { recursive: true });
  }
});

test('present old account retains privileged roles while the same player can replace accounts again', async () => {
  const f = fixture();
  try {
    f.members.set('one', { guildId: 'g', bot: false, discordId: 'one', displayName: 'One', roleIds: ['a', 'division', 'captain-access'] });
    const preview = await f.service.preview('admin', 'one', 'new');
    assert.ok(preview.plan.manualReview.some((item) => item.includes('captain-access')));
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
    assert.deepEqual(f.members.get('one')!.roleIds, ['captain-access']);
    f.members.set('third', { guildId: 'g', bot: false, discordId: 'third', displayName: 'One Third', roleIds: ['other-access'] });
    const second = await f.service.preview('admin', 'new', 'third');
    const next = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'new', newDiscordId: 'third', expectedFingerprint: second.fingerprint, samePlayerConfirmed: true });
    assert.equal((await settle(f, next.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[5]![4], 'third');
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[5]![6], 'Captain');
    assert.deepEqual(f.members.get('new')!.roleIds, ['unmanaged']);
    assert.deepEqual(f.members.get('third')!.roleIds.sort(), ['a', 'division', 'other-access']);
    assert.deepEqual(draftPickHistoricalIds(f.gateway.rows('admin', 'Draft Picks')[5]!), ['one', 'new']);
    await assert.rejects(() => f.service.record('admin', 'missing'), /this guild/i);
  } finally { f.worker.stop(); f.db.close(); }
});

test('a halfway two-workbook failure remains partial until an explicit recovery verifies the missing public change', async () => {
  const f = fixture();
  try {
    f.members.get('new')!.displayName = 'One New';
    const write = f.gateway.batchUpdate.bind(f.gateway);
    f.gateway.batchUpdate = async (workbook, updates) => {
      if (workbook === 'public') throw Error('ambiguous public write timeout');
      return write(workbook, updates);
    };
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[5]![4], 'new');
    assert.equal(f.gateway.rows('public', 'Vanaheim Roster')[4]![2], 'One');
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /read-back/i);
    // An operator repairs the exact owned cell in this isolated test environment.
    f.gateway.rows('public', 'Vanaheim Roster')[4]![2] = 'One New';
    const recovery = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, 1, 'recovery must not replay either workbook write');
  } finally { f.worker.stop(); f.db.close(); }
});
