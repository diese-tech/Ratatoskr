import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import {
  cacheVerifiedLeagueMember,
  getVerifiedLeagueMember,
  listLeagueFindings,
  replaceLeagueFindings,
} from '../db/repositories/leagueVerifiedState.js';
import { getLeagueJobByDedupe, type LeagueJobType } from '../db/repositories/leagueJobs.js';
import { LeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import {
  checkLeagueMember,
  DIRTY_RECHECK_MS,
  observeLeagueMember,
  scheduleDirtyLeagueCheck,
} from './leagueReconciliation.js';
import { cleanLeagueSnapshot } from './leagueOpsFixtures.test-support.js';
import {
  refreshLeagueOpsPanel,
  runLeagueAudit,
  type LeagueAuditCard,
  type LeagueAuditCardPort,
} from './leagueAudit.js';
import { getLeagueAuditState } from '../db/repositories/leagueAudits.js';
const now = new Date('2026-10-05T12:00:00Z');
const noWork: LeagueJobHandler = async () => {};
const handlers: Record<LeagueJobType, LeagueJobHandler> = {
  transaction: noWork,
  repair: noWork,
  targeted: noWork,
  panel: noWork,
  dirty: noWork,
  audit: noWork,
  heartbeat: noWork,
};
function setup() {
  const db = openDatabase(':memory:');
  const worker = new LeagueJobWorker(
    db,
    'g',
    handlers,
    async () => {},
    () => now,
  );
  worker.stop();
  const snapshot = cleanLeagueSnapshot();
  const targetedReads: string[] = [];
  const input = {
    db,
    operationScope: db,
    guildId: 'g',
    freeAgentRoleId: 'fa',
    now,
    members: {
      getMember: async (id: string) => {
        targetedReads.push(id);
        return snapshot.discordMembers.find((member) => member.discordId === id) ?? null;
      },
    },
    sheets: { loadMember: async () => structuredClone(snapshot) },
  };
  for (const member of snapshot.discordMembers)
    cacheVerifiedLeagueMember(db, 'g', member.discordId, snapshot, now, 'full');
  return { db, worker, snapshot, input, targetedReads };
}
test('display-name drift triggers targeted work; irrelevant roles stop; burst events coalesce by Discord ID', () => {
  const f = setup();
  try {
    const original = f.snapshot.discordMembers[0]!;
    assert.equal(
      observeLeagueMember(f.db, f.worker, { ...original, roleIds: [...original.roleIds, 'unmanaged'] }, 'one'),
      false,
    );
    assert.equal(observeLeagueMember(f.db, f.worker, { ...original, displayName: 'New One' }, 'one'), true);
    const first = getLeagueJobByDedupe(f.db, 'g', 'member:one')!;
    observeLeagueMember(f.db, f.worker, { ...original, displayName: 'Newer One' }, 'one');
    observeLeagueMember(f.db, f.worker, null, 'one');
    assert.equal(getLeagueJobByDedupe(f.db, 'g', 'member:one')?.reference, first.reference);
    assert.equal(new Date(first.availableAt).getTime() - now.getTime(), 2500);
    assert.equal(
      (f.db.prepare("SELECT count(*) count FROM league_jobs WHERE type='targeted'").get() as { count: number }).count,
      1,
    );
  } finally {
    f.worker.stop();
    f.db.close();
  }
});
test('fresh targeted verification clears false cache drift and keeps independent name findings together', async () => {
  const f = setup();
  try {
    f.snapshot.discordMembers[0]!.displayName = 'New One';
    f.snapshot.discordMembers[1]!.displayName = 'New Two';
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    await checkLeagueMember({ ...f.input, discordId: 'two' });
    assert.deepEqual(f.targetedReads, ['one', 'two']);
    assert.equal(listLeagueFindings(f.db, 'g').filter((entry) => entry.resourceKey.startsWith('member:')).length, 2);
    assert.equal(getVerifiedLeagueMember(f.db, 'g', 'one')?.names[0]?.currentLeagueName, 'One');
    assert.equal(scheduleDirtyLeagueCheck(f.db, f.worker), true);
    const dirty = getLeagueJobByDedupe(f.db, 'g', 'dirty')!;
    assert.equal(new Date(dirty.availableAt).getTime() - now.getTime(), DIRTY_RECHECK_MS);
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    assert.equal(listLeagueFindings(f.db, 'g').length, 2);
    f.snapshot.discordMembers[0]!.displayName = 'One';
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    assert.equal(listLeagueFindings(f.db, 'g').length, 1);
    f.snapshot.discordMembers[1]!.displayName = 'Two';
    await checkLeagueMember({ ...f.input, discordId: 'two' });
    assert.equal(listLeagueFindings(f.db, 'g').length, 0);
    assert.equal(scheduleDirtyLeagueCheck(f.db, f.worker), false);
    assert.equal(getVerifiedLeagueMember(f.db, 'g', 'one')?.member?.displayName, 'One');
  } finally {
    f.worker.stop();
    f.db.close();
  }
});
test('leave and rejoin check current membership without automatically mutating rosters', async () => {
  const f = setup();
  try {
    const departed = f.snapshot.discordMembers.shift()!;
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    assert.match(listLeagueFindings(f.db, 'g')[0]!.findings[0]!, /no longer in the Discord server/);
    assert.equal(f.snapshot.rosters.length, 2);
    f.snapshot.discordMembers.push(departed);
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    assert.deepEqual(listLeagueFindings(f.db, 'g'), []);
  } finally {
    f.worker.stop();
    f.db.close();
  }
});
class Panel implements LeagueAuditCardPort {
  sent: Array<{ id: string; card: LeagueAuditCard; reference: string }> = [];
  events: string[] = [];
  edits = 0;
  fail = false;
  lose = false;
  failDelete = false;
  async send(card: LeagueAuditCard, reference: string) {
    if (this.fail) throw Error('delivery failed');
    const id = `m${this.sent.length + 1}`;
    this.sent.push({ id, card, reference });
    this.events.push(`send:${id}`);
    if (this.lose) {
      this.lose = false;
      throw Error('lost response');
    }
    return id;
  }
  async findByReference(reference: string) {
    return this.sent.find((entry) => entry.reference === reference)?.id;
  }
  async edit(id: string, card: LeagueAuditCard, reference: string) {
    this.edits++;
    const entry = this.sent.find((entry) => entry.id === id)!;
    entry.card = card;
    entry.reference = reference;
    this.events.push(`edit:${id}`);
  }
  async delete(id: string) {
    if (this.failDelete) {
      this.failDelete = false;
      throw Error('cleanup failed');
    }
    this.events.push(`delete:${id}`);
  }
}
test('healthy startup restores one panel; independent drifts edit it in place; hourly replacement sends before delete', async () => {
  const f = setup();
  const cards = new Panel();
  try {
    const audit = {
      ...f.input,
      trigger: 'startup' as const,
      members: { getMembers: async () => f.snapshot.discordMembers },
      sheets: { load: async () => ({ snapshot: f.snapshot, sources: {} as never }) },
      cards,
    };
    await runLeagueAudit(audit);
    assert.equal(cards.sent.length, 1);
    assert.match(cards.sent[0]!.card.description, /Status: Healthy/);
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    assert.equal(cards.sent.length, 1);
    f.snapshot.discordMembers[0]!.displayName = 'First';
    f.snapshot.discordMembers[1]!.displayName = 'Second';
    await checkLeagueMember({ ...f.input, discordId: 'one' });
    await checkLeagueMember({ ...f.input, discordId: 'two' });
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    assert.match(cards.sent[0]!.card.description, /Player names: 2/);
    assert.equal(cards.sent.length, 1);
    const id = getLeagueAuditState(f.db, 'g')!.currentMessageId;
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now, repost: true });
    assert.deepEqual(cards.events.slice(-2), ['send:m2', `delete:${id}`]);
    assert.equal(getLeagueAuditState(f.db, 'g')!.currentMessageId, 'm2');
  } finally {
    f.worker.stop();
    f.db.close();
  }
});
test('failed heartbeat preserves old authority; ambiguous delivery is adopted after recovery without duplicates', async () => {
  const f = setup();
  const cards = new Panel();
  try {
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    cards.fail = true;
    await assert.rejects(
      refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now, repost: true }),
      /delivery failed/,
    );
    assert.equal(getLeagueAuditState(f.db, 'g')!.currentMessageId, 'm1');
    assert.deepEqual(cards.events, ['send:m1']);
    cards.fail = false;
    cards.lose = true;
    await assert.rejects(refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now }), /lost response/);
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    assert.equal(cards.sent.length, 2);
    assert.equal(getLeagueAuditState(f.db, 'g')!.currentMessageId, 'm2');
    assert.ok(cards.events.indexOf('delete:m1') > cards.events.indexOf('send:m2'));
  } finally {
    f.worker.stop();
    f.db.close();
  }
});

for (const failure of ['ambiguous send', 'failed cleanup']) {
  test(`heartbeat retry adopts its replacement without reposting after ${failure}`, async () => {
    const f = setup();
    const cards = new Panel();
    try {
      await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
      cards.lose = failure === 'ambiguous send';
      cards.failDelete = failure === 'failed cleanup';
      await assert.rejects(refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now, repost: true }));
      f.snapshot.discordMembers[0]!.displayName = 'Changed during recovery';
      await checkLeagueMember({ ...f.input, discordId: 'one' });
      const recoveredAt = new Date(now.getTime() + 60_000);
      await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now: recoveredAt, repost: true });
      assert.equal(cards.sent.length, 2);
      assert.equal(getLeagueAuditState(f.db, 'g')!.currentMessageId, 'm2');
      assert.equal(getLeagueAuditState(f.db, 'g')!.phase, 'settled');
      assert.equal(getLeagueAuditState(f.db, 'g')!.lastRepostAt, recoveredAt.toISOString());
      assert.deepEqual(cards.events.filter((event) => event.startsWith('delete:')), ['delete:m1']);
      assert.equal(cards.events.at(-1), 'edit:m2');
      assert.match(cards.sent[1]!.card.description, /Player names: 1/);
    } finally {
      f.worker.stop();
      f.db.close();
    }
  });
}

test('hourly heartbeat restores its deadline from persistent delivery time and does not perform an audit', async () => {
  const { startLeaguePanelHeartbeat, PANEL_HEARTBEAT_MS } = await import('./leagueReconciliation.js');
  const f = setup();
  const cards = new Panel();
  let delay = 0;
  let callback!: () => void;
  try {
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    f.db.prepare('UPDATE league_audit_cards SET last_repost_at=? WHERE guild_id=?').run(now.toISOString(), 'g');
    const stop = startLeaguePanelHeartbeat(f.db, f.worker, {
      now: () => new Date(now.getTime() + 600_000),
      setTimer: (run, wait) => {
        callback = run;
        delay = wait;
        return {};
      },
      clearTimer: () => {},
    });
    assert.equal(delay, PANEL_HEARTBEAT_MS - 600_000);
    callback();
    assert.equal(getLeagueJobByDedupe(f.db, 'g', 'heartbeat')?.type, 'heartbeat');
    assert.equal(getLeagueJobByDedupe(f.db, 'g', 'audit'), undefined);
    assert.equal(delay, PANEL_HEARTBEAT_MS);
    stop();
  } finally {
    f.worker.stop();
    f.db.close();
  }
});

test('SQLite reopen restores one authoritative panel and outstanding dirty retry intent', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'league-panel-'));
  const path = join(directory, 'state.db');
  let db = openDatabase(path);
  const snapshot = cleanLeagueSnapshot();
  const cards = new Panel();
  let worker = new LeagueJobWorker(
    db,
    'g',
    handlers,
    async () => {},
    () => now,
  );
  worker.stop();
  const auditInput = () => ({
    db,
    operationScope: db,
    guildId: 'g',
    freeAgentRoleId: 'fa',
    now,
    trigger: 'startup' as const,
    members: { getMembers: async () => snapshot.discordMembers },
    sheets: { load: async () => ({ snapshot, sources: {} as never }) },
    cards,
  });
  try {
    await runLeagueAudit(auditInput());
    replaceLeagueFindings(db, 'g', 'member:one', ['A verified drift'], now);
    scheduleDirtyLeagueCheck(db, worker);
    const retry = getLeagueJobByDedupe(db, 'g', 'dirty')!;
    db.close();
    db = openDatabase(path);
    worker = new LeagueJobWorker(
      db,
      'g',
      handlers,
      async () => {},
      () => now,
    );
    worker.stop();
    scheduleDirtyLeagueCheck(db, worker);
    assert.equal(getLeagueJobByDedupe(db, 'g', 'dirty')?.reference, retry.reference);
    assert.equal(getLeagueAuditState(db, 'g')?.currentMessageId, 'm1');
    await runLeagueAudit(auditInput());
    assert.equal(cards.sent.length, 1);
    assert.equal(getLeagueAuditState(db, 'g')?.currentMessageId, 'm1');
    assert.match(cards.sent[0]!.card.description, /Status: Healthy/);
  } finally {
    worker.stop();
    db.close();
    rmSync(directory, { recursive: true });
  }
});
