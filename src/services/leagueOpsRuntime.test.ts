import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client, Guild } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { enqueueLeagueJob, getLeagueJob, transitionLeagueJob } from '../db/repositories/leagueJobs.js';
import {
  createLeagueTransaction,
  getLeagueTransaction,
  transitionLeagueTransaction,
} from '../db/repositories/leagueOperations.js';
import { buildTradePlan, type LeagueMutationPlan } from '../domain/leagueOperations.js';
import { leagueTransactionPlanFingerprint } from './leagueTransactions.js';
import type { DiscordLeagueGateway } from './leagueDiscord.js';
import { cleanLeagueSnapshot } from './leagueOpsFixtures.test-support.js';
import { getVerifiedLeagueMember, cacheVerifiedLeagueMember } from '../db/repositories/leagueVerifiedState.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
process.env.ROLE_ALLFATHER_ID = 'admin-role';
process.env.ROLE_AESIR_ID = 'staff-role';
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'g';
const { createLeagueOpsRuntime } = await import('./leagueOpsRuntime.js');
async function fixture() {
  const db = openDatabase(':memory:');
  const snapshot = cleanLeagueSnapshot();
  let writes = 0;
  let loads = 0;
  let authorized = true;
  let failWrite = false;
  let failNotice = false;
  let noticeAttempts = 0;
  const sheets = {
    load: async () => {
      loads++;
      return { snapshot: structuredClone(snapshot), sources: {} as never };
    },
    loadMember: async () => structuredClone(snapshot),
    assertUnchanged: async () => {},
    prepare: () => ({ publicUpdates: [] }),
    apply: async (_loaded: unknown, plan: LeagueMutationPlan) => {
      writes++;
      if (failWrite) throw Error('write response lost');
      snapshot.rosters = structuredClone(plan.rosters);
      snapshot.names = structuredClone(plan.nameUpdates);
      for (const change of plan.publicChanges) {
        const publicRoster = snapshot.publicRosters[change.division]!;
        const group = change.area === 'team' ? publicRoster.teams[change.group]! : publicRoster.freeAgents;
        const index = group.indexOf(change.from);
        if (index >= 0) {
          if (change.to) group[index] = change.to;
          else group.splice(index, 1);
        } else if (change.to) group.push(change.to);
      }
    },
    appendTransactionHistory: async () => {},
  };
  const discord = {
    getMembers: async () => structuredClone(snapshot.discordMembers),
    getMember: async (id: string) => snapshot.discordMembers.find((member) => member.discordId === id) ?? null,
    validateMemberAbsent: async () => {},
    validateRoleState: async () => {},
    validateDisplayName: async () => {},
    applyRoleChange: async (change: { discordId: string; remove: string[]; add: string[] }) => {
      const member = snapshot.discordMembers.find((m) => m.discordId === change.discordId)!;
      member.roleIds = member.roleIds.filter((id) => !change.remove.includes(id));
      member.roleIds.push(...change.add);
    },
    rollbackRoleChange: async () => {},
    findAnnouncement: async () => undefined,
    announce: async () => {
      noticeAttempts++;
      if (failNotice) {
        failNotice = false;
        throw Error('notice unavailable');
      }
      return 'notice';
    },
    reconcileManagedRoles: async () => {},
  } as unknown as DiscordLeagueGateway;
  const guild = {
    id: 'g',
    members: { fetch: async () => ({ roles: { cache: new Map(authorized ? [['admin-role', {}]] : []) } }) },
  } as unknown as Guild;
  const sent: string[] = [];
  const cards = {
    send: async () => {
      sent.push('panel');
      return 'panel';
    },
    edit: async () => {},
    delete: async () => {},
    findByReference: async () => undefined,
  };
  const runtime = createLeagueOpsRuntime({
    db,
    operationScope: db,
    client: {} as Client,
    guild,
    sheets,
    freeAgentRoleId: 'fa',
    transactionsChannelId: 'notices',
    discord,
    cards,
  });
  const intent = (actorUserId = 'admin') => ({
    selections: '["trade","one","two"]',
    actorUserId,
    actorName: 'Admin',
    expectedPlanFingerprint: leagueTransactionPlanFingerprint(buildTradePlan(snapshot, 'one', 'two')),
  });
  return {
    db,
    snapshot,
    sheets,
    discord,
    runtime,
    intent,
    sent,
    get writes() {
      return writes;
    },
    get loads() {
      return loads;
    },
    deny() {
      authorized = false;
    },
    fail() {
      failWrite = true;
    },
    failNoticeOnce() {
      failNotice = true;
    },
    get noticeAttempts() {
      return noticeAttempts;
    },
  };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, reference: string) {
  for (let iteration = 0; iteration < 100; iteration++) {
    const job = getLeagueJob(f.db, reference)!;
    if (['COMPLETED', 'BLOCKED_REVIEW', 'RECONCILIATION_REQUIRED', 'FAILED'].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('job did not settle');
}
test('queued execution uses fresh sheets, never cached write state; transaction completion queues panel refresh', async () => {
  const f = await fixture();
  try {
    const stale = cleanLeagueSnapshot();
    stale.rosters[0]!.player = 'Cache is not authority';
    cacheVerifiedLeagueMember(f.db, 'g', 'one', stale, new Date(), 'test');
    const job = f.runtime.worker.enqueue('transaction', f.intent(), 'approval');
    f.runtime.worker.start();
    const completed = await settled(f, job.reference);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(f.writes, 1);
    assert.ok(f.loads >= 2);
    assert.equal(getLeagueTransaction(f.db, job.reference)?.status, 'completed');
    assert.equal(getVerifiedLeagueMember(f.db, 'g', 'one')?.rosters[0]?.teamRoleId, 'b');
    assert.equal(
      (f.db.prepare("SELECT count(*) count FROM league_jobs WHERE type='panel'").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(f.sent, []); // presentation remains separate from canonical completion
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});
test('stale approved plan after queue wait is blocked for review without any external write', async () => {
  const f = await fixture();
  const release = await acquireLeagueTransaction(f.db, 'g');
  try {
    const job = f.runtime.worker.enqueue('transaction', f.intent(), 'approval');
    f.runtime.worker.start();
    f.snapshot.rosters[0]!.rosterStatus = 'Captain';
    f.snapshot.names[0]!.leagueStatus = 'Captain';
    release();
    const blocked = await settled(f, job.reference);
    assert.equal(blocked.status, 'BLOCKED_REVIEW');
    assert.equal(f.writes, 0);
    assert.ok(blocked.result);
    assert.equal(getLeagueTransaction(f.db, job.reference), undefined);
  } finally {
    release();
    f.runtime.stop();
    f.db.close();
  }
});
test('execution rechecks approving actor access after queueing', async () => {
  const f = await fixture();
  try {
    const job = f.runtime.worker.enqueue('transaction', f.intent(), 'approval');
    f.deny();
    f.runtime.worker.start();
    assert.equal((await settled(f, job.reference)).status, 'BLOCKED_REVIEW');
    assert.equal(f.writes, 0);
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});
test('ambiguous external writes stay actionable and are not automatically replayed', async () => {
  const f = await fixture();
  try {
    f.fail();
    const job = f.runtime.worker.enqueue('transaction', f.intent(), 'approval');
    f.runtime.worker.start();
    assert.equal((await settled(f, job.reference)).status, 'RECONCILIATION_REQUIRED');
    assert.equal(f.writes, 1);
    await f.runtime.worker.drain();
    assert.equal(f.writes, 1);
    assert.equal(getLeagueTransaction(f.db, job.reference)?.status, 'reconciliation_required');
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});
test('actual runtime recovery inspects fresh sources, resumes pre-write intent and preserves ambiguous records', async () => {
  const f = await fixture();
  try {
    const pre = enqueueLeagueJob(f.db, { guildId: 'g', type: 'transaction', payload: f.intent(), dedupeKey: 'pre' });
    transitionLeagueJob(f.db, pre.reference, 'VALIDATING');
    const ambiguous = enqueueLeagueJob(f.db, {
      guildId: 'g',
      type: 'transaction',
      payload: f.intent('second'),
      dedupeKey: 'ambiguous',
    });
    transitionLeagueJob(f.db, ambiguous.reference, 'APPLYING');
    createLeagueTransaction(f.db, {
      reference: ambiguous.reference,
      guildId: 'g',
      kind: 'trade',
      actorUserId: 'second',
      payload: {},
    });
    await f.runtime.worker.recover();
    assert.ok(f.loads >= 2);
    assert.equal(getLeagueJob(f.db, ambiguous.reference)?.status, 'RECONCILIATION_REQUIRED');
    assert.equal(getLeagueJob(f.db, pre.reference)?.status, 'QUEUED');
    f.runtime.worker.start();
    assert.equal((await settled(f, pre.reference)).status, 'COMPLETED');
    assert.equal(f.writes, 1);
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});
test('recovery recognizes transaction reliability records already completed without replay', async () => {
  const f = await fixture();
  try {
    const job = enqueueLeagueJob(f.db, {
      guildId: 'g',
      type: 'transaction',
      payload: f.intent(),
      dedupeKey: 'completed',
    });
    transitionLeagueJob(f.db, job.reference, 'VERIFYING');
    createLeagueTransaction(f.db, {
      reference: job.reference,
      guildId: 'g',
      kind: 'trade',
      actorUserId: 'admin',
      payload: {},
    });
    transitionLeagueTransaction(f.db, job.reference, 'applying_discord', 'applying_sheets');
    transitionLeagueTransaction(f.db, job.reference, 'applying_sheets', 'announcement_pending');
    transitionLeagueTransaction(f.db, job.reference, 'announcement_pending', 'completed');
    await f.runtime.worker.recover();
    assert.equal(getLeagueJob(f.db, job.reference)?.status, 'COMPLETED');
    assert.equal(f.writes, 0);
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});

test('dirty worker rechecks known players without a full audit and cancels the next pass on clean convergence', async () => {
  const { replaceLeagueFindings } = await import('../db/repositories/leagueVerifiedState.js');
  const f = await fixture();
  try {
    for (const id of ['one', 'two']) replaceLeagueFindings(f.db, 'g', `member:${id}`, ['Prior name drift'], new Date());
    const job = f.runtime.worker.enqueue('dirty', {}, 'dirty');
    f.runtime.worker.start();
    assert.equal((await settled(f, job.reference)).status, 'COMPLETED');
    assert.equal(f.loads, 0);
    assert.equal(
      (
        f.db
          .prepare("SELECT count(*) count FROM league_jobs WHERE type='dirty' AND status IN ('QUEUED','RETRYING')")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});

test('public notice failure keeps durable recovery and retries delivery without repeating the canonical mutation', async () => {
  const f = await fixture();
  try {
    f.failNoticeOnce();
    const job = f.runtime.worker.enqueue('transaction', f.intent(), 'notice-approval');
    f.runtime.worker.start();
    const pending = await settled(f, job.reference);
    assert.equal(pending.status, 'RECONCILIATION_REQUIRED');
    assert.equal(getLeagueTransaction(f.db, job.reference)?.status, 'announcement_pending');
    assert.equal(f.writes, 1);
    assert.equal(f.noticeAttempts, 1);
    f.db
      .prepare("UPDATE league_jobs SET available_at='2000-01-01T00:00:00Z' WHERE type='dirty' AND status='QUEUED'")
      .run();
    await f.runtime.worker.drain();
    assert.equal(getLeagueJob(f.db, job.reference)?.status, 'COMPLETED');
    assert.equal(getLeagueTransaction(f.db, job.reference)?.status, 'completed');
    assert.equal(f.writes, 1);
    assert.equal(f.noticeAttempts, 2);
  } finally {
    f.runtime.stop();
    f.db.close();
  }
});
