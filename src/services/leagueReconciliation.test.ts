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
      assert.deepEqual(
        cards.events.filter((event) => event.startsWith('delete:')),
        ['delete:m1'],
      );
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

for (const status of [429, 503]) {
  test(`a Sheets ${status} preserves verified findings and review controls until fresh recovery`, async () => {
    const f = setup();
    const cards = new Panel();
    let unavailable = false;
    const audit = {
      ...f.input,
      trigger: 'scheduled' as const,
      members: { getMembers: async () => f.snapshot.discordMembers },
      sheets: {
        load: async () => {
          if (unavailable) throw { status };
          return { snapshot: f.snapshot, sources: {} as never };
        },
      },
      cards,
    };
    try {
      f.snapshot.discordMembers[0]!.displayName = 'New name';
      await runLeagueAudit(audit);
      const verifiedAt = getLeagueAuditState(f.db, 'g')!.lastFullAt;
      unavailable = true;
      await runLeagueAudit({ ...audit, now: new Date(now.getTime() + 120_000) });
      const state = getLeagueAuditState(f.db, 'g')!;
      assert.equal(state.result, 'error');
      assert.equal(state.lastFullAt, verifiedAt);
      assert.equal(state.findings.length, 1);
      assert.match(state.findings[0]!, /Discord name now/);
      assert.match(cards.sent[0]!.card.description, new RegExp(String(status)));
      assert.match(cards.sent[0]!.card.description, /last verified reads/);
      assert.equal(cards.sent[0]!.card.actions?.[0]?.label, 'Review issues');
      assert.equal(cards.sent.length, 1);
      unavailable = false;
      await runLeagueAudit(audit);
      assert.equal(getLeagueAuditState(f.db, 'g')!.result, 'dirty');
      assert.doesNotMatch(cards.sent[0]!.card.description, /429|503/);
    } finally {
      f.worker.stop();
      f.db.close();
    }
  });
}

test('resolved alert deletion retries durably and leaves ambiguous repair records open', async () => {
  const { createOrGetLeagueReconciliationTicket, markLeagueReconciliationTicketAlerted, resolveOpenLeagueReconciliationTickets, listResolvedLeagueAlertReferences, getLeagueReconciliationTicket } = await import('../db/repositories/leagueOperations.js');
  const { createLeagueAuditRepair, markLeagueAuditRepairReconciliationRequired } = await import('../db/repositories/leagueAuditRepairs.js');
  const f = setup();
  const cards = new Panel();
  const deleted: string[][] = [];
  let fail = true;
  const port: LeagueAuditCardPort = Object.assign(cards, { deleteResolvedAlerts: async (references: string[]) => {
    if (fail) throw Error('Discord cleanup unavailable');
    deleted.push(references);
  } });
  try {
    for (const reference of ['resolved-alert', 'ambiguous-repair']) {
      createOrGetLeagueReconciliationTicket(f.db, { reference, guildId: 'g', actorUserId: 'admin', fingerprint: reference, summary: 'Old issue' });
      markLeagueReconciliationTicketAlerted(f.db, reference);
    }
    createLeagueAuditRepair(f.db, { reference: 'ambiguous-repair', guildId: 'g', auditReference: 'old', actorUserId: 'admin', finding: 'Old issue', action: 'repair-roles' });
    markLeagueAuditRepairReconciliationRequired(f.db, 'ambiguous-repair', 'Outcome unknown');
    assert.equal(resolveOpenLeagueReconciliationTickets(f.db, 'g'), 1);
    assert.equal(getLeagueReconciliationTicket(f.db, 'ambiguous-repair')!.status, 'open');
    await assert.rejects(refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now }), /cleanup unavailable/);
    assert.deepEqual(listResolvedLeagueAlertReferences(f.db, 'g'), ['resolved-alert']);
    fail = false;
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now });
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now });
    assert.deepEqual(deleted, [['resolved-alert']]);
    assert.deepEqual(listResolvedLeagueAlertReferences(f.db, 'g'), []);
    assert.equal(getLeagueReconciliationTicket(f.db, 'ambiguous-repair')!.status, 'open');
  } finally { f.worker.stop(); f.db.close(); }
});

test('historical cleanup selects only bot-owned standalone alerts with an exact resolved reference', async () => {
  const { isResolvedLeagueAlertMessage } = await import('./leagueAuditDiscord.js');
  const references = new Set(['YSL-REC-resolved']);
  const message = { author: { id: 'rat' }, content: 'Ratatoskr could not finish **League sheet reconciliation**.\nReference: YSL-REC-resolved' };
  assert.equal(isResolvedLeagueAlertMessage(message, 'rat', references), true);
  assert.equal(isResolvedLeagueAlertMessage({ ...message, author: { id: 'human' } }, 'rat', references), false);
  assert.equal(isResolvedLeagueAlertMessage({ ...message, content: message.content + '-open' }, 'rat', references), false);
  assert.equal(isResolvedLeagueAlertMessage({ ...message, content: 'League Ops Status\nReference: YSL-REC-resolved' }, 'rat', references), false);
  assert.equal(isResolvedLeagueAlertMessage(message, undefined, references), false);
});

test('duplicate malformed roster diagnostics remain readable in the persistent panel', async () => {
  const f = setup();
  const cards = new Panel();
  try {
    f.snapshot.rosters.push({ ...f.snapshot.rosters[0]!, sheetRow: 100 });
    f.snapshot.names = f.snapshot.names.filter((row) => row.discordId !== 'one');
    await runLeagueAudit({ ...f.input, trigger: 'scheduled', members: { getMembers: async () => f.snapshot.discordMembers },
      sheets: { load: async () => ({ snapshot: f.snapshot, sources: {} as never }) }, cards });
    const findings = listLeagueFindings(f.db, 'g').flatMap((entry) => entry.findings);
    assert.ok(findings.length > 0);
    assert.ok(findings.every((finding) => typeof finding === 'string'));
    assert.match(cards.sent[0]!.card.description, /Attention required/);
    assert.equal(cards.sent[0]!.card.actions?.[0]?.label, 'Review issues');
    f.db.prepare("UPDATE league_findings SET findings_json='[null]' WHERE guild_id='g'").run();
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    assert.match(cards.sent[0]!.card.description, /Attention required/);
    assert.ok(listLeagueFindings(f.db, 'g').every((entry) => entry.findings.every((finding) => typeof finding === 'string')));
  } finally { f.worker.stop(); f.db.close(); }
});

test('partial operations expose recovery controls and prevent legacy alert cleanup until explicitly reconciled', async () => {
  const { createLeagueAuditRepair, markLeagueAuditRepairReconciliationRequired } = await import('../db/repositories/leagueAuditRepairs.js');
  const { previewLeagueRepairRecovery, reconcileLeagueRepairRecord } = await import('./leagueRepairRecovery.js');
  const f = setup();
  const cards = new Panel();
  const cleanups: string[] = [];
  let failCleanup = true;
  const port: LeagueAuditCardPort = Object.assign(cards, { deleteLegacyResolvedAlerts: async (at: string) => {
    if (failCleanup) throw Error('cleanup unavailable');
    cleanups.push(at);
  } });
  const input = { ...f.input, members: { getMembers: async () => f.snapshot.discordMembers },
    sheets: { load: async () => ({ snapshot: f.snapshot, sources: {} as never }) }, cards: port };
  try {
    createLeagueAuditRepair(f.db, { reference: 'old-repair', guildId: 'g', actorUserId: 'old-admin', auditReference: 'old', finding: 'Old finding', action: 'use-discord-name' });
    markLeagueAuditRepairReconciliationRequired(f.db, 'old-repair', 'Interrupted');
    await runLeagueAudit({ ...input, trigger: 'scheduled' });
    assert.ok(cards.sent[0]!.card.actions?.some((action) => action.label === 'Review operations'));
    assert.ok(cards.sent[0]!.card.actions?.some((action) => action.label === 'Recheck roster'));
    assert.deepEqual(cleanups, []);
    const preview = await previewLeagueRepairRecovery(input, 'old-repair');
    await reconcileLeagueRepairRecord({ ...input, reference: 'old-repair', actorUserId: 'admin', expectedFingerprint: preview.fingerprint });
    await assert.rejects(refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now }), /cleanup unavailable/);
    assert.match(cards.sent[0]!.card.description, /Status: Healthy/);
    failCleanup = false;
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now });
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now });
    assert.deepEqual(cleanups, [getLeagueAuditState(f.db, 'g')!.lastFullAt]);
  } finally { f.worker.stop(); f.db.close(); }
});

test('heartbeat retry after legacy alert cleanup failure edits its replacement without posting another panel', async () => {
  const f = setup();
  const cards = new Panel();
  let fail = false;
  const port: LeagueAuditCardPort = Object.assign(cards, { deleteLegacyResolvedAlerts: async () => { if (fail) throw Error('cleanup failed'); } });
  try {
    await runLeagueAudit({ ...f.input, trigger: 'scheduled', members: { getMembers: async () => f.snapshot.discordMembers },
      sheets: { load: async () => ({ snapshot: f.snapshot, sources: {} as never }) }, cards: port });
    f.db.prepare("DELETE FROM league_alert_cleanup WHERE guild_id='g'").run();
    fail = true;
    const queuedAt = new Date(Date.parse(getLeagueAuditState(f.db, 'g')!.lastRepostAt!) + 3_600_000).toISOString();
    await assert.rejects(refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now: new Date(queuedAt), repost: true, repostQueuedAt: queuedAt }), /cleanup failed/);
    assert.equal(cards.sent.length, 2);
    fail = false;
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now: new Date(Date.parse(queuedAt) + 60_000), repost: true, repostQueuedAt: queuedAt });
    assert.equal(cards.sent.length, 2);
    assert.equal(cards.events.at(-1), 'edit:m2');
  } finally { f.worker.stop(); f.db.close(); }
});

test('targeted convergence after a dirty full audit cannot authorize legacy cleanup', async () => {
  const f = setup();
  const cards = new Panel();
  const cleaned: string[] = [];
  const port: LeagueAuditCardPort = Object.assign(cards, { deleteLegacyResolvedAlerts: async (at: string) => { cleaned.push(at); } });
  const input = { ...f.input, members: { getMembers: async () => f.snapshot.discordMembers },
    sheets: { load: async () => ({ snapshot: f.snapshot, sources: {} as never }) }, cards: port };
  try {
    const original = f.snapshot.discordMembers[0]!.displayName;
    f.snapshot.discordMembers[0]!.displayName = 'Dirty full audit';
    await runLeagueAudit({ ...input, trigger: 'scheduled' });
    assert.equal(getLeagueAuditState(f.db, 'g')!.lastCleanFullAt, null);
    f.snapshot.discordMembers[0]!.displayName = original;
    await checkLeagueMember({ ...f.input, discordId: 'one', now: new Date(now.getTime() + 60_000) });
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards: port, now: new Date(now.getTime() + 60_000) });
    assert.match(cards.sent[0]!.card.description, /Status: Healthy/);
    assert.deepEqual(cleaned, []);
    const cleanAt = new Date(now.getTime() + 120_000);
    await runLeagueAudit({ ...input, trigger: 'scheduled', now: cleanAt });
    assert.equal(getLeagueAuditState(f.db, 'g')!.lastCleanFullAt, cleanAt.toISOString());
    assert.equal(getLeagueAuditState(f.db, 'g')!.lastFullAt, cleanAt.toISOString());
    assert.deepEqual(cleaned, [cleanAt.toISOString()]);
  } finally { f.worker.stop(); f.db.close(); }
});

test('transaction-only interruptions do not advertise an audit-repair recovery button', async () => {
  const { createLeagueTransaction, markLeagueTransactionReconciliationRequired } = await import('../db/repositories/leagueOperations.js');
  const f = setup();
  const cards = new Panel();
  try {
    createLeagueTransaction(f.db, { reference: 'old-transaction', guildId: 'g', kind: 'trade', actorUserId: 'admin', payload: {} });
    markLeagueTransactionReconciliationRequired(f.db, 'old-transaction', 'Interrupted transaction');
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', cards, now });
    assert.ok(!cards.sent[0]!.card.actions?.some((action) => action.label === 'Review operations'));
    assert.doesNotMatch(cards.sent[0]!.card.description, /Select Review operations/);
    assert.match(cards.sent[0]!.card.description, /transaction notice\/history for: old-transaction/);
    assert.match(cards.sent[0]!.card.description, /Do not replay the transaction/);
  } finally { f.worker.stop(); f.db.close(); }
});
