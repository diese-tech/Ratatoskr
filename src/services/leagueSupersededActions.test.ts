import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../db/client.js';
import { enqueueLeagueJob, getLeagueJob, listActionableLeagueJobs, listUnfinishedLeagueMutationJobs, transitionLeagueJob } from '../db/repositories/leagueJobs.js';
import { LeagueOpsReviewService } from './leagueOpsReview.js';
import { refreshLeagueOpsPanel, type LeagueAuditCard } from './leagueAudit.js';

function fixture(actor = 'second-admin', path = ':memory:', choices: unknown[] = ['drop', 'outgoing', 'replacement']) {
  const db = openDatabase(path);
  const selections = JSON.stringify(choices);
  const original = enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', dedupeKey: 'original',
    payload: { selections, actorUserId: 'first-admin', actorName: 'First admin' } });
  const error = 'Ratatoskr made no changes. Reconcile Discord, Current Rosters, Player Name History, and the public roster, then retry. League audit failed. Missing Player is in Current Rosters but is no longer in the Discord server. Confirm whether this is a departure before changing the roster.';
  transitionLeagueJob(db, original.reference, 'BLOCKED_REVIEW', { error });
  const retry = enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', dedupeKey: 'retry',
    payload: { selections, actorUserId: actor, originalBlockedReference: original.reference } });
  const canonical = (reference = retry.reference, status = 'completed', guild = 'g', kind = String(choices[0])) => {
    db.prepare('INSERT INTO league_transactions(reference,guild_id,kind,actor_user_id,payload_json,status) VALUES(?,?,?,?,?,?)')
      .run(reference, guild, kind, actor, '{}', status);
  };
  const service = new LeagueOpsReviewService({ db, guildId: 'g', scope: db,
    worker: {} as never, replacement: {} as never, authorize: async () => 'Staff',
    previewTransaction: async () => assert.fail('No replay or external reads permitted'),
    previewRepair: async () => assert.fail('No repair permitted') });
  return { db, original, retry, canonical, service, error };
}

test('cross-staff linked canonical success heals inventory and preserves inspectable history without writes', async () => {
  const f = fixture();
  try {
    f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED');
    const before = f.db.prepare('SELECT total_changes() AS count').get();
    assert.deepEqual(listUnfinishedLeagueMutationJobs(f.db, 'g'), []);
    assert.deepEqual(listActionableLeagueJobs(f.db, 'g'), []);
    assert.deepEqual((await f.service.snapshot('admin')).operations, []);
    const detail = await f.service.operationDetail('admin', f.original.reference);
    assert.equal(detail.status, 'SUPERSEDED');
    assert.ok(detail.next.includes(f.retry.reference));
    assert.equal(detail.error, f.error);
    assert.equal(detail.canRepreview, false); assert.equal(detail.canRecover, false);
    assert.equal(getLeagueJob(f.db, f.original.reference)?.status, 'BLOCKED_REVIEW');
    assert.equal(getLeagueJob(f.db, f.original.reference)?.lastError, f.error);
    assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(), before);
    await assert.rejects(f.service.previewTransaction('admin', f.original.reference), /pre-write/);
    let card: LeagueAuditCard | undefined;
    await refreshLeagueOpsPanel({ db: f.db, guildId: 'g', now: new Date(), cards: {
      findByReference: async () => undefined, send: async value => { card = value; return 'panel'; },
      delete: async () => assert.fail('No old public message to delete'),
    } });
    assert.doesNotMatch(card!.description, /unfinished action/);
    assert.deepEqual(f.db.prepare('SELECT status FROM league_transactions WHERE reference=?').get(f.retry.reference), { status: 'completed' });
  } finally { f.db.close(); }
});

test('same-staff queued and failed retries cannot hide a blocked original at enqueue time', () => {
  const f = fixture('first-admin');
  try {
    assert.ok(listUnfinishedLeagueMutationJobs(f.db, 'g').some(j => j.reference === f.original.reference));
    transitionLeagueJob(f.db, f.retry.reference, 'FAILED');
    assert.ok(listActionableLeagueJobs(f.db, 'g').some(j => j.reference === f.original.reference));
  } finally { f.db.close(); }
});

test('all command selection shapes resolve, including standalone exits with null replacements', () => {
  const choices = [
    ...['trade', 'pickup', 'rename', 'drop', 'self-drop', 'departure'].map(kind => [kind, 'player', 'second']),
    ...['drop', 'self-drop', 'departure'].flatMap(kind => [[kind, 'player', null], [kind, 'player']]),
  ];
  for (const selection of choices) {
    const f = fixture('second-admin', ':memory:', selection);
    try {
      f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED');
      assert.deepEqual(listUnfinishedLeagueMutationJobs(f.db, 'g'), [], JSON.stringify(selection));
    } finally { f.db.close(); }
  }
});

test('malformed action-specific selections never resolve an original', () => {
  for (const selection of [['trade','player',null], ['pickup','player'], ['rename','player',null],
    ['drop','player',false], ['drop',null,null], ['drop','player',''], ['drop','player',null,'extra'], ['other','player',null]]) {
    const f = fixture('second-admin', ':memory:', selection);
    try {
      f.canonical(f.retry.reference, 'completed', 'g', selection[0] === 'other' ? 'drop' : String(selection[0]));
      transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED');
      assert.ok(listUnfinishedLeagueMutationJobs(f.db, 'g').some(j => j.reference === f.original.reference), JSON.stringify(selection));
    } finally { f.db.close(); }
  }
});

test('resolution survives reopening the database and works through a read-only connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-successor-'));
  const path = join(directory, 'test.db');
  try {
    const f = fixture('second-admin', path);
    f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED');
    f.db.close();
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      assert.deepEqual(listUnfinishedLeagueMutationJobs(db, 'g'), []);
      assert.deepEqual(listActionableLeagueJobs(db, 'g'), []);
      assert.equal(getLeagueJob(db, f.original.reference)?.lastError, f.error);
      assert.equal(getLeagueJob(db, f.original.reference)?.status, 'BLOCKED_REVIEW');
    } finally { db.close(); }
  } finally {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
});

test('successor and no-write proof reject unsafe, unrelated and incomplete records', () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['queued successor', f => { f.canonical(); }],
    ['failed successor', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'FAILED'); }],
    ['missing canonical completion', f => { transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); }],
    ...['failed', 'announcement_pending', 'reconciliation_required', 'applying_sheets'].map(status =>
      [status, (f: ReturnType<typeof fixture>) => { f.canonical(f.retry.reference, status); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); }] as [string, (f: ReturnType<typeof fixture>) => void]),
    ['canonical wrong guild', f => { f.canonical(f.retry.reference, 'completed', 'other'); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); }],
    ['canonical wrong action', f => { f.canonical(f.retry.reference, 'completed', 'g', 'pickup'); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); }],
    ['unlinked success', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("UPDATE league_jobs SET payload_json=json_remove(payload_json,'$.originalBlockedReference') WHERE reference=?").run(f.retry.reference); }],
    ['different selections', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("UPDATE league_jobs SET payload_json=json_set(payload_json,'$.selections','[\"pickup\",\"other\"]') WHERE reference=?").run(f.retry.reference); }],
    ['successor wrong guild', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("UPDATE league_jobs SET guild_id='other' WHERE reference=?").run(f.retry.reference); }],
    ['successor not later', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare('UPDATE league_jobs SET sequence=100 WHERE reference=?').run(f.original.reference); }],
    ['original canonical evidence', f => { f.canonical(); f.canonical(f.original.reference, 'failed'); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); }],
    ['original interrupted status', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); transitionLeagueJob(f.db, f.original.reference, 'RECONCILIATION_REQUIRED'); }],
    ['original audit repair', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("INSERT INTO league_audit_repairs(reference,guild_id,audit_reference,actor_user_id,finding,action,status) VALUES(?,'g','audit','staff','finding','repair-roles','failed')").run(f.original.reference); }],
    ...[false, true].map(linked => [linked ? 'linked replacement evidence' : 'original replacement evidence', (f: ReturnType<typeof fixture>) => {
      f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED');
      const reference = linked ? f.retry.reference : f.original.reference;
      f.db.prepare("INSERT INTO league_account_replacements(reference,guild_id,old_discord_id,new_discord_id,actor_user_id,before_fingerprint,after_fingerprint,plan_json,status) VALUES(?,'g','old','new','staff','before','after','{}','failed')").run(reference);
      if (linked) f.db.prepare('INSERT INTO league_account_replacement_evidence(reference,job_reference) VALUES(?,?)').run(reference, f.original.reference);
    }] as [string, (f: ReturnType<typeof fixture>) => void]),
    ['unresolved original ticket', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("INSERT INTO league_reconciliation_tickets(reference,guild_id,actor_user_id,fingerprint,summary) VALUES(?,'g','staff','fingerprint','review')").run(f.original.reference); }],
    ['malformed selections', f => { f.canonical(); transitionLeagueJob(f.db, f.retry.reference, 'COMPLETED'); f.db.prepare("UPDATE league_jobs SET payload_json=json_set(payload_json,'$.selections','not-json') WHERE reference IN (?,?)").run(f.original.reference,f.retry.reference); }],
  ];
  for (const [name, change] of cases) {
    const f = fixture();
    try {
      change(f);
      assert.ok(listUnfinishedLeagueMutationJobs(f.db, 'g').some(j => j.reference === f.original.reference), name);
    } finally { f.db.close(); }
  }
});
