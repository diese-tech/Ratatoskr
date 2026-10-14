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
  return { ...sources, sources, db, service, worker, deny: () => { allowed = false; }, allow: () => { allowed = true; } };
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
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true as const };
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

test('another active teams captain access cannot overlap replacement-managed roles', async () => {
  const f = fixture();
  try {
    f.gateway.rows('admin', 'League Teams')[6]![9] = 'a';
    await assert.rejects(() => f.service.preview('admin', 'one', 'new'), /captain access overlaps/i);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.worker.stop(); f.db.close(); }
});

test('fresh approval retries a proven pre-write block while duplicate confirmation keeps one job', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const intent = { actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint,
      approvalReference: preview.approvalReference, samePlayerConfirmed: true as const };
    const first = await f.service.confirm(intent);
    f.deny();
    assert.equal((await settle(f, first.reference)).status, 'BLOCKED_REVIEW');
    f.allow();
    const fresh = await f.service.preview('admin', 'one', 'new');
    assert.equal(fresh.fingerprint, preview.fingerprint);
    assert.notEqual(fresh.approvalReference, preview.approvalReference);
    const newIntent = { ...intent, approvalReference: fresh.approvalReference };
    const retry = await f.service.confirm(newIntent);
    assert.notEqual(retry.reference, first.reference);
    assert.equal((await f.service.confirm(newIntent)).reference, retry.reference);
    assert.equal((await settle(f, retry.reference)).status, 'COMPLETED');
    assert.equal(getLeagueJob(f.db, first.reference)?.status, 'BLOCKED_REVIEW');
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('name-row edits during final authority reads stop before any sheet write', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    let checks = 1;
    f.discord.assertAccountReplacementRoleOwnership = async () => {
      if (++checks === 4) f.gateway.rows('admin', 'Player Name History')[8] = ['other', 'Other', 'Other', 'Previous / Alternate', 'Vanaheim', '', 'Inactive'];
    };
    assert.equal((await settle(f, job.reference)).status, 'BLOCKED_REVIEW');
    assert.equal(f.gateway.writes.length, 0);
    assert.equal(f.gateway.rows('admin', 'Player Name History')[8]![0], 'other');
    assert.equal((await f.service.record('admin', job.reference)).status, 'failed');
  } finally { f.worker.stop(); f.db.close(); }
});

test('public edits during final authority reads are preserved as a partial operation', async () => {
  const f = fixture();
  try {
    f.members.get('new')!.displayName = 'One New';
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    let checks = 1;
    f.discord.assertAccountReplacementRoleOwnership = async () => {
      if (++checks === 5) f.gateway.rows('public', 'Vanaheim Roster')[4]![2] = 'Staff edit';
    };
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    assert.equal(f.gateway.writes.length, 1);
    assert.equal(f.gateway.rows('public', 'Vanaheim Roster')[4]![2], 'Staff edit');
  } finally { f.worker.stop(); f.db.close(); }
});

test('draft duplicates introduced during manual recovery cannot change protected attribution', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    const duplicate = [...f.gateway.rows('admin', 'Draft Picks')[5]!];
    duplicate[1] = 'The Sewer'; duplicate[3] = 2;
    f.gateway.rows('admin', 'Draft Picks').push(duplicate);
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /player details or recorded moves.*need fixing/i);
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('replacement uses canonical Discord names when nicknames contain surrounding whitespace', async () => {
  const f = fixture();
  try {
    f.members.get('new')!.displayName = '  One  ';
    const preview = await f.service.preview('admin', 'one', 'new');
    assert.equal(preview.plan.newName.currentLeagueName, 'One');
    assert.equal(preview.plan.publicChanges.length, 0);
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
  } finally { f.worker.stop(); f.db.close(); }
});

test('replacement waits for older notice/history deliveries before freezing draft ownership and move status', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    f.db.prepare('INSERT INTO league_transactions(reference,guild_id,kind,actor_user_id,payload_json,status) VALUES(?,?,?,?,?,?)')
      .run('earlier-trade', 'g', 'trade', 'admin', '{}', 'announcement_pending');
    await assert.rejects(() => f.service.preview('admin', 'one', 'new'), /notices\/history must finish/i);
    await assert.rejects(() => f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true }), /notices\/history must finish/i);
    assert.equal((f.db.prepare('SELECT count(*) n FROM league_jobs').get() as { n: number }).n, 0);
    assert.equal(f.gateway.writes.length, 0);
    f.db.prepare('UPDATE league_transactions SET status=? WHERE reference=?').run('completed', 'earlier-trade');
    const fresh = await f.service.preview('admin', 'one', 'new');
    assert.ok(fresh.fingerprint);
  } finally { f.worker.stop(); f.db.close(); }
});

test('recovery protects original account and alias attribution while permitting unrelated notes', async () => {
  for (const edit of [
    (f: ReturnType<typeof fixture>) => { f.gateway.rows('admin', 'Player Name History')[5]![0] = 'another-player'; },
    (f: ReturnType<typeof fixture>) => { f.gateway.rows('admin', 'Player Name History')[6]![2] = 'Lost alias'; },
  ]) {
    const f = fixture();
    try {
      const preview = await f.service.preview('admin', 'one', 'new');
      const original = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
        expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
      f.gateway.failWorkbook = 'admin';
      assert.equal((await settle(f, original.reference)).status, 'RECONCILIATION_REQUIRED');
      edit(f);
      await assert.rejects(() => f.service.previewRecovery('admin', original.reference), /alias history changed/i);
      assert.equal(f.gateway.writes.length, 1);
    } finally { f.worker.stop(); f.db.close(); }
  }
});

test('retired nickname changes are fresh recovery evidence without retaining current-name authority', async () => {
  const f = fixture();
  try {
    f.members.set('one', { guildId: 'g', bot: false, discordId: 'one', displayName: 'One', roleIds: ['a', 'division', 'captain-access'] });
    const preview = await f.service.preview('admin', 'one', 'new');
    const original = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, original.reference)).status, 'RECONCILIATION_REQUIRED');
    f.members.get('one')!.roleIds = ['captain-access'];
    f.members.get('one')!.displayName = 'Retired nickname';
    const recovery = await f.service.previewRecovery('admin', original.reference);
    f.members.get('one')!.displayName = 'Another retired nickname';
    const stale = await f.service.confirmRecovery({ actorUserId: 'admin', reference: original.reference,
      expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, stale.reference)).status, 'BLOCKED_REVIEW');
    const fresh = await f.service.previewRecovery('admin', original.reference);
    const job = await f.service.confirmRecovery({ actorUserId: 'admin', reference: original.reference,
      expectedFingerprint: fresh.fingerprint, approvalReference: fresh.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.rows('admin', 'Player Name History')[5]![2], 'One alias');
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('a fresh recovery approval can close the original after a safely blocked acknowledgement', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const original = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, original.reference)).status, 'RECONCILIATION_REQUIRED');
    const recovery = await f.service.previewRecovery('admin', original.reference);
    const blocked = await f.service.confirmRecovery({ actorUserId: 'admin', reference: original.reference,
      expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
    f.deny();
    assert.equal((await settle(f, blocked.reference)).status, 'BLOCKED_REVIEW');
    f.allow();
    const fresh = await f.service.previewRecovery('admin', original.reference);
    assert.equal(fresh.fingerprint, recovery.fingerprint);
    const intent = { actorUserId: 'admin', reference: original.reference, expectedFingerprint: fresh.fingerprint,
      approvalReference: fresh.approvalReference, historyReviewed: true as const };
    const retry = await f.service.confirmRecovery(intent);
    assert.notEqual(retry.reference, blocked.reference);
    assert.equal((await f.service.confirmRecovery(intent)).reference, retry.reference);
    assert.equal((await settle(f, retry.reference)).status, 'COMPLETED');
    assert.equal((await f.service.record('admin', original.reference)).status, 'completed');
    assert.equal(f.gateway.writes.length, 1);
  } finally { f.worker.stop(); f.db.close(); }
});

test('recovery revalidates semantic role mappings and live permission ownership', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.gateway.rows('admin', 'League Teams')[5]![3] = 'new-role'; },
    (f: ReturnType<typeof fixture>) => { f.gateway.rows('admin', 'League Teams')[6]![9] = 'a'; },
    (f: ReturnType<typeof fixture>) => { f.discord.assertAccountReplacementRoleOwnership = async () => { throw new (class extends Error {})('Role became privileged'); }; },
  ]) {
    const f = fixture();
    try {
      const preview = await f.service.preview('admin', 'one', 'new');
      const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
        expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
      f.gateway.failWorkbook = 'admin';
      assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
      change(f);
      await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /role configuration|captain access|privileged/i);
      assert.equal((await f.service.record('admin', job.reference)).status, 'reconciliation_required');
    } finally { f.worker.stop(); f.db.close(); }
  }
});

test('same-name replacement cannot complete or recover with a missing public assignment', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new',
      expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    const write = f.gateway.batchUpdate.bind(f.gateway);
    f.gateway.batchUpdate = async (workbook, updates) => {
      await write(workbook, updates);
      f.gateway.rows('public', 'Vanaheim Roster')[4]![2] = '';
    };
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /public roster assignment/i);
    f.gateway.rows('public', 'Vanaheim Roster')[4]![2] = 'One';
    const recovery = await f.service.previewRecovery('admin', job.reference);
    assert.ok(recovery.fingerprint);
  } finally { f.worker.stop(); f.db.close(); }
});

test('recovery allows unrelated notes while requiring fresh approval and exact replacement cells', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    f.gateway.failWorkbook = 'admin';
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    f.gateway.rows('admin', 'Current Rosters')[6]![8] = 'unrelated staff note';
    const recovery = await f.service.previewRecovery('admin', job.reference);
    f.gateway.rows('admin', 'Current Rosters')[6]![8] = 'another staff note';
    const stale = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, stale.reference)).status, 'BLOCKED_REVIEW');
    f.gateway.rows('admin', 'Current Rosters')[5]![5] = 'wrong identity';
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /read-back/i);
    f.gateway.rows('admin', 'Current Rosters')[5]![5] = 'One';
    const fresh = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: fresh.fingerprint, approvalReference: fresh.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, 1);
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[6]![8], 'another staff note');
  } finally { f.worker.stop(); f.db.close(); }
});

test('an unclaimed queue intent cannot bypass the canonical worker through the execution interface', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    const recovery = await f.service.previewRecovery('admin', job.reference);
    await assert.rejects(() => f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: false as never }), /history/i);
    f.members.get('new')!.roleIds.push('new-manual-access');
    const stale = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, stale.reference)).status, 'BLOCKED_REVIEW');
    assert.equal((await f.service.record('admin', job.reference)).status, 'reconciliation_required');
    const current = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference,
      expectedFingerprint: current.fingerprint, approvalReference: current.approvalReference, historyReviewed: true });
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
        expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
      const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
    await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: one.fingerprint, approvalReference: one.approvalReference, samePlayerConfirmed: true });
    await assert.rejects(() => f.service.confirm({ actorUserId: 'other-admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: two.fingerprint, approvalReference: two.approvalReference, samePlayerConfirmed: true }), /competing/i);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.worker.stop(); f.db.close(); }
});

test('ambiguous Admin writes retain evidence, stop automatic replay and require explicit reconciliation', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('admin', 'one', 'new');
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
      expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
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
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'COMPLETED');
    assert.deepEqual(f.members.get('one')!.roleIds, ['captain-access']);
    f.members.set('third', { guildId: 'g', bot: false, discordId: 'third', displayName: 'One Third', roleIds: ['other-access'] });
    const second = await f.service.preview('admin', 'new', 'third');
    const next = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'new', newDiscordId: 'third', expectedFingerprint: second.fingerprint, approvalReference: second.approvalReference, samePlayerConfirmed: true });
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
    const job = await f.service.confirm({ actorUserId: 'admin', oldDiscordId: 'one', newDiscordId: 'new', expectedFingerprint: preview.fingerprint, approvalReference: preview.approvalReference, samePlayerConfirmed: true });
    assert.equal((await settle(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    assert.equal(f.gateway.rows('admin', 'Current Rosters')[5]![4], 'new');
    assert.equal(f.gateway.rows('public', 'Vanaheim Roster')[4]![2], 'One');
    await assert.rejects(() => f.service.previewRecovery('admin', job.reference), /read-back/i);
    // An operator repairs the exact owned cell in this isolated test environment.
    f.gateway.rows('public', 'Vanaheim Roster')[4]![2] = 'One New';
    const recovery = await f.service.previewRecovery('admin', job.reference);
    const ack = await f.service.confirmRecovery({ actorUserId: 'admin', reference: job.reference, expectedFingerprint: recovery.fingerprint, approvalReference: recovery.approvalReference, historyReviewed: true });
    assert.equal((await settle(f, ack.reference)).status, 'COMPLETED');
    assert.equal(f.gateway.writes.length, 1, 'recovery must not replay either workbook write');
  } finally { f.worker.stop(); f.db.close(); }
});
