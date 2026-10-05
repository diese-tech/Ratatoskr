import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/client.js';
import {
  enqueueLeagueJob,
  getLeagueJob,
  getLeagueJobByDedupe,
  transitionLeagueJob,
  type LeagueJobType,
} from '../db/repositories/leagueJobs.js';
import { LeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
function handlers(handler: LeagueJobHandler): Record<LeagueJobType, LeagueJobHandler> {
  return {
    transaction: handler,
    repair: handler,
    targeted: handler,
    panel: handler,
    dirty: handler,
    audit: handler,
    heartbeat: handler,
  };
}
const now = new Date('2026-10-05T12:00:00Z');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('second and third transactions queue in accepted order; duplicate returns active reference and status', async () => {
  const db = openDatabase(':memory:');
  const held = deferred();
  const began = deferred();
  const order: string[] = [];
  const worker = new LeagueJobWorker(
    db,
    'g',
    handlers(async (job) => {
      order.push(job.dedupeKey);
      if (order.length === 1) {
        began.resolve();
        await held.promise;
      }
    }),
    async () => {},
    () => now,
  );
  try {
    const first = worker.enqueue('transaction', {}, 'first');
    await began.promise;
    const second = worker.enqueue('transaction', {}, 'second');
    const third = worker.enqueue('transaction', {}, 'third');
    assert.equal(getLeagueJob(db, second.reference)?.status, 'QUEUED');
    assert.equal(worker.enqueue('transaction', {}, 'first').reference, first.reference);
    assert.equal(getLeagueJob(db, first.reference)?.status, 'LOADING');
    held.resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.equal(getLeagueJob(db, third.reference)?.status, 'COMPLETED');
  } finally {
    worker.stop();
    db.close();
  }
});
test('admin intent is accepted behind a running audit and overtakes lower priority queued work', async () => {
  const db = openDatabase(':memory:');
  const held = deferred();
  const began = deferred();
  const order: string[] = [];
  const worker = new LeagueJobWorker(
    db,
    'g',
    handlers(async (job) => {
      order.push(job.dedupeKey);
      if (job.dedupeKey === 'running') {
        began.resolve();
        await held.promise;
      }
    }),
    async () => {},
    () => now,
  );
  try {
    worker.enqueue('audit', {}, 'running');
    await began.promise;
    worker.enqueue('audit', {}, 'scheduled');
    worker.enqueue('dirty', {}, 'dirty');
    worker.enqueue('targeted', {}, 'targeted');
    const admin = worker.enqueue('transaction', {}, 'admin');
    assert.equal(admin.status, 'QUEUED');
    held.resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['running', 'admin', 'targeted', 'dirty', 'scheduled']);
  } finally {
    worker.stop();
    db.close();
  }
});
test('queue and dedupe survive SQLite reopen; interrupted pre-write rebuilds, ambiguous write never replays', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'league-queue-'));
  const path = join(directory, 'test.db');
  let db = openDatabase(path);
  const queued = enqueueLeagueJob(db, {
    guildId: 'g',
    type: 'transaction',
    payload: { selections: 'intent' },
    dedupeKey: 'queued',
    now,
  });
  const pre = enqueueLeagueJob(db, {
    guildId: 'g',
    type: 'transaction',
    payload: { selections: 'fresh' },
    dedupeKey: 'pre',
    now,
  });
  transitionLeagueJob(db, pre.reference, 'VALIDATING');
  const write = enqueueLeagueJob(db, {
    guildId: 'g',
    type: 'transaction',
    payload: { selections: 'unsafe' },
    dedupeKey: 'write',
    now,
  });
  transitionLeagueJob(db, write.reference, 'APPLYING');
  db.close();
  db = openDatabase(path);
  const executed: string[] = [];
  const worker = new LeagueJobWorker(
    db,
    'g',
    handlers(async (job) => {
      executed.push(job.dedupeKey);
    }),
    async (job) => {
      transitionLeagueJob(db, job.reference, job.status === 'APPLYING' ? 'RECONCILIATION_REQUIRED' : 'QUEUED');
    },
    () => now,
  );
  try {
    assert.equal(
      enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload: {}, dedupeKey: 'queued', now }).reference,
      queued.reference,
    );
    await worker.recover();
    await worker.drain();
    assert.deepEqual(executed, ['queued', 'pre']);
    assert.equal(getLeagueJob(db, write.reference)?.status, 'RECONCILIATION_REQUIRED');
  } finally {
    worker.stop();
    db.close();
    rmSync(directory, { recursive: true });
  }
});
test('slow presentation cannot hold canonical mutations; events arriving during a check get a successor', async () => {
  const db = openDatabase(':memory:');
  const held = deferred();
  const began = deferred();
  let mutations = 0;
  const worker = new LeagueJobWorker(
    db,
    'g',
    handlers(async (job) => {
      if (job.type === 'panel') {
        began.resolve();
        await held.promise;
      } else mutations++;
    }),
    async () => {},
    () => now,
  );
  try {
    const panel = worker.enqueue('panel', {}, 'panel');
    await began.promise;
    const successor = worker.enqueue('panel', {}, 'panel');
    assert.notEqual(successor.reference, panel.reference);
    const mutation = worker.enqueue('transaction', {}, 'mutation');
    await new Promise((r) => setImmediate(r));
    assert.equal(mutations, 1);
    assert.equal(getLeagueJob(db, mutation.reference)?.status, 'COMPLETED');
    held.resolve();
    await new Promise((r) => setImmediate(r));
  } finally {
    worker.stop();
    db.close();
  }
});
test('equivalent active approvals alias one durable mutation even after the first finishes', async () => {
  const db = openDatabase(':memory:');
  const payload = { actorUserId: 'a', selections: '["trade","1","2"]', expectedPlanFingerprint: 'approved' };
  try {
    const first = enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload, dedupeKey: 'approval-1', now });
    const second = enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload, dedupeKey: 'approval-2', now });
    assert.equal(second.reference, first.reference);
    transitionLeagueJob(db, first.reference, 'COMPLETED');
    assert.equal(getLeagueJobByDedupe(db, 'g', 'approval-2')?.status, 'COMPLETED');
    assert.equal(
      enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload, dedupeKey: 'approval-2', now }).reference,
      first.reference,
    );
  } finally {
    db.close();
  }
});

test('persistent claim prevents two worker instances from executing guild mutations concurrently', async () => {
  const db = openDatabase(':memory:');
  const held = deferred();
  const began = deferred();
  let active = 0;
  let peak = 0;
  const handler: LeagueJobHandler = async (job) => {
    active++;
    peak = Math.max(peak, active);
    if (job.dedupeKey === 'first') {
      began.resolve();
      await held.promise;
    }
    active--;
  };
  const first = new LeagueJobWorker(
    db,
    'g',
    handlers(handler),
    async () => {},
    () => now,
  );
  const second = new LeagueJobWorker(
    db,
    'g',
    handlers(handler),
    async () => {},
    () => now,
  );
  try {
    first.enqueue('transaction', {}, 'first');
    await began.promise;
    const waiting = second.enqueue('transaction', {}, 'second');
    await second.drain();
    assert.equal(getLeagueJob(db, waiting.reference)?.status, 'QUEUED');
    held.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 1);
    assert.equal(getLeagueJob(db, waiting.reference)?.status, 'COMPLETED');
  } finally {
    first.stop();
    second.stop();
    db.close();
  }
});
