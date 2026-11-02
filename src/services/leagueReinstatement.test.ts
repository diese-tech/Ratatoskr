import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import { createLeagueTransaction, getLeagueTransaction, listLeagueTransactions } from '../db/repositories/leagueOperations.js';
import { enqueueLeagueJob, getLeagueJob, recoverLeagueJobs, transitionLeagueJob } from '../db/repositories/leagueJobs.js';
import { buildDeparturePlan, buildDropPlan, buildSelfDropPlan, buildReinstatementPlan, type LeagueMutationPlan, type ReinstatementSelection, type ReinstatementSource } from '../domain/leagueOperations.js';
import { buildLeagueIntentPlan, parseReinstatementSelection } from './leagueTransactionIntent.js';
import { buildLeagueAnnouncement, executeLeagueTransaction, reconcilePendingLeagueTransactions, leagueTransactionPlanFingerprint, type LeagueDiscordPort } from './leagueTransactions.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { LeagueReinstatementService, buildVerifiedTransactionIntent, historicalPlayerChoices, historicalPlayerIndex, reinstatementPreviewText, reinstatementSources, leagueDate, type ReinstatementReview } from './leagueReinstatement.js';
process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';
const { reinstatementReviewMessage } = await import('./leagueReinstatementUi.js');
const { transactionCommand } = await import('../commands/transaction.js');

const reference = 'YSL-JOB-A4EAFBAF38A5439A';
const now = new Date('2026-11-02T16:00:00Z');
async function fixture(kind: 'departure' | 'drop' | 'self-drop' = 'departure', present = true) {
  const f = accountReplacementSources();
  const db = openDatabase(':memory:');
  f.members.delete('new');
  if (kind !== 'departure') f.members.set('one', { guildId: 'g', bot: false, discordId: 'one', displayName: 'One', roleIds: ['a', 'division'] });
  if (kind === 'self-drop') {
    (f.gateway as import('./leagueSheets.js').LeagueSheetsGateway).getSelfDropPresentation = async () => ({ sheetId: 1, legend: [['Red row', 'Self-Drop: suspended for the current season and banned for the next YSL season.']], ruleExists: true });
  }
  const loaded = await f.sheets.load([...f.members.values()], 'fa');
  const plan = kind === 'departure' ? buildDeparturePlan(loaded.snapshot, 'one') : kind === 'drop' ? buildDropPlan(loaded.snapshot, 'one') : buildSelfDropPlan(loaded.snapshot, 'one');
  const record = { reference, effectiveDate: '2026-10-31', processedById: 'fuego', processedBy: 'FuegoMyEggo' };
  await f.sheets.apply(loaded, plan, record, { publicUpdates: f.sheets.prepare(loaded, plan).publicUpdates });
  f.gateway.rows('admin', 'Transaction History').push([reference, kind, '2026-10-31', 'Vanaheim', 'Dream Walkers',
    kind === 'departure' ? 'Inactive' : kind === 'drop' ? 'Free Agents' : 'Suspended - Self-Drop (Current + Next Season)',
    'one', 'One', 'fuego', 'deleted-post', 'Completed', 'FuegoMyEggo']);
  createLeagueTransaction(db, { reference, guildId: 'g', kind, actorUserId: 'fuego', payload: { plan, record } });
  db.prepare("UPDATE league_transactions SET status='completed',created_at='2026-10-31T18:00:00Z' WHERE reference=?").run(reference);
  f.members.delete('one');
  if (present) f.members.set('one', { guildId: 'g', bot: false, discordId: 'one', displayName: 'One', roleIds: kind === 'drop' ? ['fa', 'division'] : ['unmanaged'] });
  let roleCalls = 0; let announceCalls = 0; let allowed = true; let clock = now;
  const announcements = new Map<string, { id: string; description: string }>();
  const discord: LeagueDiscordPort = {
    getMembers: async () => structuredClone([...f.members.values()]), validateMemberAbsent: async () => {},
    validateRoleState: async () => {}, validateDisplayName: async () => {}, validateReinstatementRoles: async () => {},
    applyRoleChange: async change => { roleCalls++; const member = f.members.get(change.discordId)!; member.roleIds = member.roleIds.filter(id => !change.remove.includes(id)).concat(change.add); },
    rollbackRoleChange: async change => { const member = f.members.get(change.discordId)!; member.roleIds = member.roleIds.filter(id => !change.add.includes(id)).concat(change.remove); },
    findAnnouncement: async ref => announcements.get(ref)?.id,
    announce: async (announcement, ref) => { announceCalls++; const id = `notice-${announceCalls}`; announcements.set(ref, { id, description: announcement.description }); return id; },
  };
  f.gateway.append = async (workbook, range, values) => {
    assert.equal(workbook, 'admin'); assert.equal(range, "'Transaction History'!A:M");
    f.gateway.appends++; f.gateway.rows('admin', 'Transaction History').push(...structuredClone(values));
  };
  const authorize = async () => { if (!allowed) throw Error('permission revoked'); return 'Staff'; };
  const serviceInput = { db, guildId: 'g', sheets: f.sheets, discord, freeAgentRoleId: 'fa', authorize,
    enqueue: (payload: unknown, key: string) => enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload, dedupeKey: key, now: clock }), now: () => clock };
  const service = new LeagueReinstatementService(serviceInput);
  const install = (view: ReinstatementReview, old?: string) => { service.install(view, old); return view; };
  const approve = async () => { const view = install(await service.open('staff', 'One alias')); assert.equal(view.payload.kind, 'preview');
    const approved = install(await service.exceptions('staff', view.token, view.payload.kind === 'preview' ? view.payload.plan.reinstatement!.advisories.map(a => a.id) : []), view.token); return approved; };
  const execute = async (job: ReturnType<typeof enqueueLeagueJob>) => {
    const intent = job.payload as { selections: string; expectedPlanFingerprint: string; approvedAt?: string };
    return executeLeagueTransaction({ db, operationScope: db, guildId: 'g', actorUserId: 'staff', actorName: 'Staff', freeAgentRoleId: 'fa', now: clock, approvedAt: intent.approvedAt,
      sheets: f.sheets, discord, buildPlan: (_snapshot, loaded) => buildVerifiedTransactionIntent({ db, guildId: 'g', sheets: f.sheets, selections: intent.selections, loaded }),
      expectedPlanFingerprint: intent.expectedPlanFingerprint, jobReference: job.reference, authorizeBeforeWrite: async () => { await authorize(); } });
  };
  f.gateway.writes.length = 0;
  return { ...f, db, service, serviceInput, discord, announcements, install, approve, execute,
    deny: () => { allowed = false; }, advance: (date: Date) => { clock = date; },
    get roleCalls() { return roleCalls; }, get announceCalls() { return announceCalls; }, close: () => db.close() };
}

for (const kind of ['departure', 'drop', 'self-drop'] as const) test(`${kind} is found without a reference, approved despite policy warnings, and completes once`, async () => {
  const f = await fixture(kind);
  try {
    const original = structuredClone(getLeagueTransaction(f.db, reference));
    const draft = structuredClone(f.gateway.rows('admin', 'Draft Picks').map(row => row.slice(0, 8)));
    const view = f.install(await f.service.open('staff', 'Older alias'));
    assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    assert.equal(view.payload.plan.reinstatement!.source.kind, kind);
    assert.equal(view.payload.plan.reinstatement!.source.effectiveDate, '2026-10-31');
    assert.equal(f.gateway.writes.length, 0); assert.equal(f.roleCalls, 0);
    const text = reinstatementPreviewText(view.payload.plan);
    assert.match(text, /FuegoMyEggo/); assert.match(text, /2026-10-31/); assert.match(text, /2026-11-02/); assert.doesNotMatch(text, /<t:|T00:00/);
    if (kind === 'self-drop') await assert.rejects(f.service.confirm('staff', view.token), /Choose each/);
    const approved = f.install(await f.service.exceptions('staff', view.token, view.payload.plan.reinstatement!.advisories.map(item => item.id)), view.token);
    const [job, duplicate] = await Promise.all([f.service.confirm('staff', approved.token), f.service.confirm('staff', approved.token)]);
    assert.equal(job.reference, duplicate.reference);
    const restarted = new LeagueReinstatementService(f.serviceInput);
    assert.equal((await restarted.confirm('staff', approved.token)).reference, job.reference);
    await f.execute(job); await f.execute(job);
    assert.equal(getLeagueTransaction(f.db, job.reference)!.status, 'completed');
    assert.equal((getLeagueTransaction(f.db, job.reference)!.payload as { record: { approvedAt: string } }).record.approvedAt, now.toISOString());
    assert.deepEqual(getLeagueTransaction(f.db, reference), original);
    const after = await f.sheets.load([...f.members.values()], 'fa');
    assert.equal(after.snapshot.rosters.filter(row => row.discordId === 'one').length, 1);
    assert.equal(after.snapshot.names.find(row => row.discordId === 'one' && row.nameStatus === 'Current Discord Name')!.leagueStatus, 'Player');
    assert.deepEqual(f.members.get('one')!.roleIds.filter(id => ['a', 'division'].includes(id)).sort(), ['a', 'division']);
    assert.ok(after.snapshot.publicRosters.Vanaheim!.teams['Dream Walkers']!.includes('One'));
    const history = f.gateway.rows('admin', 'Transaction History').filter(row => row[0] === job.reference);
    assert.equal(history.length, 1); assert.equal(history[0]![4], kind === 'departure' ? 'Inactive' : kind === 'drop' ? 'Free Agent' : 'Suspended - Self-Drop (Current + Next Season)');
    assert.equal(history[0]![2], '2026-11-02'); assert.match(String(history[0]![11]), new RegExp(reference));
    assert.ok(f.announcements.get(job.reference)!.description.includes(String(history[0]![2])));
    assert.doesNotMatch(f.announcements.get(job.reference)!.description, /YSL-JOB|fuego|Suspended/);
    assert.equal(f.announceCalls, 1); assert.equal(f.gateway.appends, 1);
    assert.deepEqual(f.gateway.rows('admin', 'Draft Picks').map(row => row.slice(0, 8)), draft);
    await assert.rejects(f.service.open('staff', 'One'), /later roster action|already rostered/);
  } finally { f.close(); }
});

test('absent identities remain searchable and previewable, with an actionable technical limitation and no false role changes', async () => {
  const f = await fixture('departure', false);
  try {
    const view = f.install(await f.service.open('staff', 'One alias'));
    assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    assert.deepEqual(view.payload.plan.discordRoleChanges, []);
    assert.match(view.payload.plan.reinstatement!.blockers.join(' '), /rejoin/);
    await assert.rejects(f.service.confirm('staff', view.token), /absent/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM league_jobs').get() && listLeagueTransactions(f.db, 'g').length, 1);
    assert.equal(f.gateway.writes.length, 0); assert.equal(f.roleCalls, 0);
  } finally { f.close(); }
});

test('ambiguous historical names and multiple exits require explicit private selection, with pagination and an optional reference', async () => {
  const f = await fixture();
  try {
    const source = getLeagueTransaction(f.db, reference)!;
    for (let i = 0; i < 26; i++) {
      createLeagueTransaction(f.db, { reference: `exit-${i}`, guildId: 'g', kind: 'departure', actorUserId: 'fuego', payload: source.payload });
      f.db.prepare("UPDATE league_transactions SET status='completed',created_at='2026-10-01T00:00:00Z' WHERE reference=?").run(`exit-${i}`);
      f.gateway.rows('admin', 'Transaction History').push([`exit-${i}`, 'departure', '2026-10-01', 'Vanaheim', 'Dream Walkers', 'Inactive', 'one', 'Old recorded alias', 'fuego', '', 'Completed', 'FuegoMyEggo']);
    }
    let view = f.install(await f.service.open('staff', 'One'));
    assert.equal(view.payload.kind, 'picker'); assert.equal(reinstatementReviewMessage(view).components[0]!.components.length, 1);
    const page = await f.service.page('staff', view.token, 1); f.install(page, view.token); view = page;
    assert.equal(view.payload.kind, 'picker'); if (view.payload.kind !== 'picker') return;
    const index = view.payload.candidates.findIndex(item => item.reference === reference);
    assert.ok(index >= 25);
    await assert.rejects(f.service.choose('staff', view.token, '0'), /current list/);
    const chosen = await f.service.choose('staff', view.token, String(index)); assert.equal(chosen.payload.kind, 'preview');
    const explicit = await f.service.open('staff', 'One', reference); assert.equal(explicit.payload.kind, 'preview');
    const first = f.install(await f.service.open('staff', 'One'));
    await assert.rejects(f.service.choose('staff', first.token, '0'), /later roster action/);
  } finally { f.close(); }
});

test('stale source dates, source duplicates, sheet notes, roles, active identity, permissions, cancelled controls and dates refuse confirmation', async () => {
  for (const change of ['source-date', 'duplicate-source', 'sheet-note', 'roles', 'active', 'permission', 'cancel', 'new-day'] as const) {
    const f = await fixture();
    try {
      const view = await f.approve();
      if (change === 'source-date') f.gateway.rows('admin', 'Transaction History').at(-1)![2] = '2026-10-30';
      if (change === 'duplicate-source') f.gateway.rows('admin', 'Transaction History').push([...f.gateway.rows('admin', 'Transaction History').at(-1)!]);
      if (change === 'sheet-note') f.gateway.rows('admin', 'Player Name History')[5]![10] = 'staff changed note';
      if (change === 'roles') f.members.get('one')!.roleIds.push('division');
      if (change === 'active') f.gateway.rows('admin', 'Current Rosters').push(['Vanaheim', 'Dream Walkers', 'a', 'Dream Walkers VD', 'one', 'One', 'Player']);
      if (change === 'permission') f.deny();
      if (change === 'cancel') await f.service.cancel('staff', view.token);
      if (change === 'new-day') f.advance(new Date('2026-11-03T16:00:00Z'));
      await assert.rejects(f.service.confirm('staff', view.token));
      assert.equal(f.roleCalls, 0); assert.equal(f.gateway.writes.length, 0);
      assert.equal((f.db.prepare('SELECT count(*) n FROM league_jobs').get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test('replaced and expired previews cannot be replayed by their owner or another actor', async () => {
  const f = await fixture();
  try {
    const old = f.install(await f.service.open('staff', 'One'));
    const fresh = await f.approve();
    await f.service.cancel('staff', old.token);
    await assert.rejects(f.service.confirm('other', fresh.token), /expired|replaced/);
    f.advance(new Date(now.getTime() + 16 * 60_000));
    await assert.rejects(f.service.confirm('staff', fresh.token), /expired/);
  } finally { f.close(); }
});

test('7/7 is a nonblocking policy advisory; the fixed public layout is a separate representation blocker', async () => {
  const f = await fixture();
  try {
    const loaded = await f.sheets.load([...f.members.values()], 'fa');
    const source = (await reinstatementSources(f.db, 'g', f.sheets))[0]!;
    for (let i = 0; i < 7; i++) loaded.snapshot.rosters.push({ sheetRow: 20 + i, division: 'Vanaheim', franchise: 'Dream Walkers', teamRoleId: 'a', team: 'Dream Walkers VD', discordId: `extra-${i}`, player: `Extra ${i}`, rosterStatus: 'Player' });
    for (let i = 0; i < 7; i++) loaded.snapshot.names.push({ sheetRow: 20 + i, division: 'Vanaheim', franchise: 'Dream Walkers', discordId: `extra-${i}`, currentLeagueName: `Extra ${i}`, knownName: `Extra ${i}`, nameStatus: 'Current Discord Name', leagueStatus: 'Player' });
    const selection: ReinstatementSelection = { version: 1, kind: 'reinstate', playerId: 'one', sourceReference: reference, teamRoleId: 'a', returnStatus: 'Player', effectiveDate: '2026-11-02', overrides: ['timing', 'roster-count'], preserveFutureSanction: true };
    const plan = buildReinstatementPlan(loaded.snapshot, selection, source);
    assert.ok(plan.reinstatement!.advisories.some(item => item.id === 'roster-count'));
    assert.deepEqual(plan.reinstatement!.blockers, []);
    f.sheets.prepare(loaded, plan); // Policy does not itself reject a representable plan.
    for (let row = 5; row <= 11; row++) loaded.sources.publicByDivision.Vanaheim[row - 1]![2] = `Occupied ${row}`;
    assert.throws(() => f.sheets.prepare(loaded, plan), /empty owned cell|fixed Sheet layout/);
    assert.equal(f.gateway.writes.length, 0);
  } finally { f.close(); }
});

test('interrupted role/Sheet writes quarantine privately, while notice/history recovery converges without duplicate effects', async () => {
  for (const failure of ['discord', 'sheet', 'notice', 'history'] as const) {
    const f = await fixture();
    try {
      const view = await f.approve(); const job = await f.service.confirm('staff', view.token);
      if (failure === 'discord') f.discord.applyRoleChange = async () => { throw Object.assign(Error('response lost'), { reconciliationRequired: true }); };
      if (failure === 'sheet') f.gateway.failWorkbook = 'admin';
      if (failure === 'notice') {
        const send = f.discord.announce; f.discord.announce = async (...args) => { await send(...args); throw Error('response lost'); };
      }
      const append = f.gateway.append;
      if (failure === 'history') f.gateway.append = async (...args) => { await append(...args); throw Error('append response lost'); };
      await assert.rejects(f.execute(job));
      assert.equal(getLeagueTransaction(f.db, job.reference)!.status, ['discord', 'sheet'].includes(failure) ? 'reconciliation_required' : 'announcement_pending');
      f.gateway.failWorkbook = undefined; f.gateway.append = append;
      await reconcilePendingLeagueTransactions({ db: f.db, sheets: f.sheets, discord: f.discord });
      assert.equal(getLeagueTransaction(f.db, job.reference)!.status, ['discord', 'sheet'].includes(failure) ? 'reconciliation_required' : 'completed');
      if (failure === 'notice' || failure === 'history') { assert.equal(f.announceCalls, 1); assert.equal(f.gateway.appends, 1); }
      else { assert.equal(f.announceCalls, 0); assert.equal(f.gateway.appends, 0); }
    } finally { f.close(); }
  }
});

test('history retries reject conflicting reference rows rather than falsely completing', async () => {
  const f = await fixture();
  try {
    const view = await f.approve(); const job = await f.service.confirm('staff', view.token); await f.execute(job);
    const tx = getLeagueTransaction(f.db, job.reference)!;
    const { plan, record } = tx.payload as { plan: LeagueMutationPlan; record: import('./leagueSheets.js').LeagueTransactionRecord };
    record.announcementId = tx.announcementId!;
    f.gateway.rows('admin', 'Transaction History').at(-1)![5] = 'Another team';
    await assert.rejects(f.sheets.appendTransactionHistory(plan, record), /conflicting values/);
    assert.equal(f.gateway.appends, 1);
  } finally { f.close(); }
});

test('legacy intents remain supported; source identity, provenance, override and date changes participate in deterministic fingerprints', async () => {
  const f = await fixture('self-drop');
  try {
    const view = await f.approve(); assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    const selection = parseReinstatementSelection(view.payload.selections)!;
    assert.equal(selection.version, 1); assert.equal(selection.preserveFutureSanction, true);
    const loaded = await f.sheets.load([...f.members.values()], 'fa');
    loaded.snapshot.discordMembers.find(member => member.discordId === 'two')!.nickname = null;
    assert.equal(buildLeagueIntentPlan('["rename","two","Two Prime"]', loaded.snapshot).kind, 'rename');
    const original = view.payload.fingerprint;
    for (const change of [{ overrides: [] }, { reason: 'staff exception' }, { effectiveDate: '2026-11-03' }]) {
      const changed = await buildVerifiedTransactionIntent({ db: f.db, guildId: 'g', sheets: f.sheets, loaded, selections: JSON.stringify({ ...selection, ...change }) });
      assert.notEqual(leagueTransactionPlanFingerprint(changed), original);
    }
    assert.throws(() => parseReinstatementSelection(JSON.stringify({ ...selection, version: 2 })));
  } finally { f.close(); }
});

test('league dates remain sheet-aligned over DST and UTC day rollover; a missing original post never requires fetching Discord history', () => {
  assert.equal(leagueDate(new Date('2026-11-01T03:59:00Z')), '2026-10-31');
  assert.equal(leagueDate(new Date('2026-11-01T06:01:00Z')), '2026-11-01');
  const option = transactionCommand.toJSON().options!.find(option => option.name === 'reinstate')!;
  assert.equal(option.type, 1); assert.equal('options' in option && option.options!.find(option => option.name === 'player')!.type, 3);
});


test('worker revalidation blocks source/role/permission changes after enqueue, and restart never replays a possibly partial write', async () => {
  for (const changed of ['source', 'roles', 'permission', 'partial'] as const) {
    const f = await fixture();
    try {
      const approved = await f.approve(); const job = await f.service.confirm('staff', approved.token);
      if (changed === 'source') f.gateway.rows('admin', 'Transaction History').at(-1)![2] = '2026-10-29';
      if (changed === 'roles') f.members.get('one')!.roleIds.push('division');
      if (changed === 'permission') f.deny();
      if (changed === 'partial') {
        transitionLeagueJob(f.db, job.reference, 'APPLYING');
        const intent = job.payload as { selections: string };
        const loaded = await f.sheets.load([...f.members.values()], 'fa');
        const plan = await buildVerifiedTransactionIntent({ db: f.db, guildId: 'g', sheets: f.sheets, loaded, selections: intent.selections });
        createLeagueTransaction(f.db, { reference: job.reference, guildId: 'g', kind: 'reinstatement', actorUserId: 'staff', payload: { plan, record: {} } });
        process.env.DISCORD_TOKEN = 'test'; process.env.DISCORD_CLIENT_ID = 'test'; process.env.DISCORD_GUILD_ID = 'g';
        const { createLeagueOpsRuntime } = await import('./leagueOpsRuntime.js');
        const runtime = createLeagueOpsRuntime({ db: f.db, operationScope: f.db, client: {} as never,
          guild: { id: 'g' } as never, sheets: f.sheets, discord: f.discord as never, freeAgentRoleId: 'fa', transactionsChannelId: 'notices', cards: {} as never });
        try { await runtime.worker.recover(); } finally { runtime.stop(); }
      }
      await assert.rejects(f.execute(job));
      assert.equal(f.roleCalls, 0); assert.equal(f.gateway.writes.length, 0); assert.equal(f.announceCalls, 0);
      if (changed === 'partial') {
        assert.equal(getLeagueJob(f.db, job.reference)!.status, 'RECONCILIATION_REQUIRED');
        assert.throws(() => createLeagueTransaction(f.db, { reference: 'competing', guildId: 'g', kind: 'reinstatement', actorUserId: 'other', payload: getLeagueTransaction(f.db, job.reference)!.payload }), /UNIQUE/);
      }
    } finally { f.close(); }
  }
});

test('same-name identities are never guessed and history aliases remain discoverable', async () => {
  const f = await fixture();
  try {
    const transaction = getLeagueTransaction(f.db, reference)!;
    const payload = structuredClone(transaction.payload) as { plan: LeagueMutationPlan };
    payload.plan.playerIds[0] = 'another'; payload.plan.players[0] = 'One';
    createLeagueTransaction(f.db, { reference: 'other-exit', guildId: 'g', kind: 'departure', actorUserId: 'fuego', payload });
    f.db.prepare("UPDATE league_transactions SET status='completed' WHERE reference='other-exit'").run();
    f.gateway.rows('admin', 'Transaction History').push(['other-exit', 'departure', '2026-10-31', 'Vanaheim', 'Dream Walkers', 'Inactive', 'another', 'One', 'fuego', '', 'Completed', 'Fuego']);
    f.gateway.rows('admin', 'Player Name History').push(['another', 'One', 'Alias two', 'Current Discord Name', 'Vanaheim', '', 'Inactive']);
    const picker = await f.service.open('staff', 'One'); assert.equal(picker.payload.kind, 'picker');
    if (picker.payload.kind !== 'picker') return;
    assert.deepEqual(new Set(picker.payload.candidates.map(item => item.playerId)), new Set(['one', 'another']));
    const names = await f.sheets.listHistoricalNames();
    assert.equal(historicalPlayerChoices(historicalPlayerIndex(f.db, 'g', names), 'Alias two')[0]!.value, 'another');
  } finally { f.close(); }
});

test('Manny incident is a read-only fixture: historical departure, exact Sheet date, original team and absent-member limitation', async () => {
  const f = await fixture('departure', false);
  try {
    // Synthetic reconstruction from #183, never a production database or workbook read.
    const replace = (value: unknown): unknown => typeof value === 'string'
      ? value === 'one' ? '345713643998150656' : value === 'One' ? 'thehofather' : value === 'One alias' ? 'manny'
        : value === 'Dream Walkers' ? 'The Sewer' : value === 'The Sewer' ? 'Other'
          : value === 'Vanaheim' ? 'Svartalfheim' : value
      : Array.isArray(value) ? value.map(replace)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)])) : value;
    for (const [key, rows] of f.gateway.data) f.gateway.data.set(key, replace(rows) as typeof rows);
    const originalPublic = f.gateway.rows('public', 'Vanaheim Roster');
    f.gateway.data.set('public:Vanaheim Roster', f.gateway.rows('public', 'Svartalfheim Roster'));
    f.gateway.data.set('public:Svartalfheim Roster', originalPublic);
    const tx = getLeagueTransaction(f.db, reference)!;
    f.db.prepare('UPDATE league_transactions SET payload_json=? WHERE reference=?').run(JSON.stringify(replace(tx.payload)), reference);
    const view = await f.service.open('staff', 'thehofather');
    assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    const text = reinstatementPreviewText(view.payload.plan);
    assert.match(text, /345713643998150656/); assert.match(text, /departure/); assert.match(text, /2026-10-31/);
    assert.match(text, /The Sewer \(Svartalfheim\)/); assert.match(text, /FuegoMyEggo/); assert.match(text, /rejoin/);
    assert.doesNotMatch(text, /self-drop|<t:/i);
    assert.equal(f.gateway.writes.length, 0); assert.equal(f.roleCalls, 0);
  } finally { f.close(); }
});


test('private saved-action details link the original and completed reinstatement in both directions with Sheet dates', async () => {
  const f = await fixture();
  try {
    const view = await f.approve(); const job = await f.service.confirm('staff', view.token);
    const { LeagueOpsReviewService } = await import('./leagueOpsReview.js');
    const review = new LeagueOpsReviewService({ db: f.db, guildId: 'g', scope: f.db, worker: {} as never, replacement: {} as never,
      authorize: async () => 'Staff', readTransactionHistory: () => f.sheets.readTransactionHistory(),
      previewTransaction: async () => { throw Error('unused'); }, previewRepair: async () => { throw Error('unused'); } });
    const waiting = await review.operationDetail('staff', job.reference);
    assert.equal(waiting.action, 'reinstate'); assert.ok(waiting.targets.some(target => target.includes(reference)));
    await f.execute(job);
    transitionLeagueJob(f.db, job.reference, 'COMPLETED');
    const original = await review.operationDetail('staff', reference);
    const returned = await review.operationDetail('staff', job.reference);
    assert.deepEqual(original.linkedReferences, [job.reference]); assert.deepEqual(returned.linkedReferences, [reference]);
    assert.match(original.historyDetails!.join(' '), /2026-10-31/);
    assert.match(returned.historyDetails!.join(' '), /2026-11-02/); assert.match(returned.historyDetails!.join(' '), /not waived/);
    assert.doesNotMatch(returned.historyDetails!.join(' '), /<t:/);
  } finally { f.close(); }
});


test('delayed precise job completion remains a labeled advisory, never a replacement for the official historical Sheet date', async () => {
  const f = await fixture();
  try {
    f.db.prepare(`INSERT INTO league_jobs(reference,guild_id,type,priority,payload_json,status,dedupe_key,created_at,available_at,completed_at)
      VALUES(?,'g','transaction',1,'{}','COMPLETED','original','2026-10-31T18:00:00Z','2026-10-31T18:00:00Z','2026-11-01T05:30:00Z')`).run(reference);
    const view = await f.service.open('staff', 'One'); assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    const text = reinstatementPreviewText(view.payload.plan);
    assert.match(text, /Original: 2026-10-31/); assert.match(text, /job Completed: 2026-11-01T05:30:00Z \(staff advisory only\)/);
    assert.match(text, /Exact elapsed time unavailable/); assert.doesNotMatch(text, /<t:/);
    f.gateway.rows('admin', 'Transaction History').at(-1)![2] = '2026-10-31T23:10:00-04:00';
    const precise = await f.service.open('staff', 'One'); assert.equal(precise.payload.kind, 'preview'); if (precise.payload.kind !== 'preview') return;
    assert.match(reinstatementPreviewText(precise.payload.plan), /Original: 2026-10-31T23:10:00-04:00/);
    f.gateway.rows('admin', 'Transaction History').at(-1)![2] = '2026-02-30';
    await assert.rejects(f.service.open('staff', 'One'), /No matching completed exit/);
  } finally { f.close(); }
});


test('private previews translate unrelated member and role-configuration drift while keeping raw diagnostics in logs', async t => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { diagnostics.push(args); });
  for (const drift of ['member', 'configuration'] as const) {
    const f = await fixture();
    try {
      if (drift === 'member') f.members.get('two')!.roleIds = ['division'];
      else f.gateway.rows('admin', 'League Teams')[6]![7] = 'b';
      const view = f.install(await f.service.open('staff', 'One'));
      assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') continue;
      const blockers = view.payload.plan.reinstatement!.blockers.join(' ');
      assert.ok(blockers.length);
      assert.doesNotMatch(blockers, /Discord member two|Role b is configured|Division role b|Team role b/);
      if (drift === 'member') assert.match(blockers, /Two is listed on The Sewer VD.*missing that team role.*Restore the role/);
      else assert.match(blockers, /The Sewer VD is used as both a team role and a division role in League Teams.*Give each purpose/);
      const message = reinstatementReviewMessage(view);
      const text = message.embeds[0]!.toJSON().description!;
      assert.ok(text.includes(blockers.split(' ').slice(0, 8).join(' ')));
      assert.doesNotMatch(text, /Discord member two|Role b is configured/);
      assert.equal(message.components.at(-1)!.components.at(-1)!.toJSON().disabled, true);
      await assert.rejects(f.service.confirm('staff', view.token));
      assert.equal(f.roleCalls, 0); assert.equal(f.gateway.writes.length, 0);
    } finally { f.close(); }
  }
  assert.match(JSON.stringify(diagnostics), /Discord member two is rostered without its team role/);
  assert.match(JSON.stringify(diagnostics), /Role b is configured as both a team role and a division role/);
});


test('timing alone never requires acknowledgement: date-only and >24h returns confirm and execute directly without an exception menu', async () => {
  for (const kind of ['departure', 'drop'] as const) {
    const f = await fixture(kind);
    try {
      const view = f.install(await f.service.open('staff', 'One'));
      assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') continue;
      assert.deepEqual(view.payload.plan.reinstatement!.advisories, []);
      assert.deepEqual(view.payload.plan.reinstatement!.selection.overrides, []);
      const message = reinstatementReviewMessage(view);
      const controls = message.components.flatMap(row => row.components.map(control => control.toJSON()));
      assert.equal(controls.some(control => control.type === 3), false);
      assert.equal(controls.find(control => 'label' in control && control.label === 'Confirm reinstatement')!.disabled, false);
      const text = message.embeds[0]!.toJSON().description!;
      assert.match(text, /Original: 2026-10-31.*2026-11-02/);
      assert.match(text, /informational only.*Exact elapsed time unavailable/);
      assert.doesNotMatch(text, /Approve timing|\[Review\].*24-hour/);
      const job = await f.service.confirm('staff', view.token);
      const selection = parseReinstatementSelection((job.payload as { selections: string }).selections)!;
      assert.deepEqual(selection.overrides, []);
      await f.execute(job);
      assert.equal(getLeagueTransaction(f.db, job.reference)!.status, 'completed');
    } finally { f.close(); }
  }
});

test('substantive suspension and roster-count exceptions still require explicit acknowledgement, independently of timing', async () => {
  const f = await fixture('self-drop');
  try {
    const view = f.install(await f.service.open('staff', 'One'));
    assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    assert.deepEqual(view.payload.plan.reinstatement!.advisories.map(item => item.id), ['discipline']);
    let message = reinstatementReviewMessage(view);
    assert.equal(message.components.at(-1)!.components.at(-1)!.toJSON().disabled, true);
    assert.deepEqual(message.components[0]!.toJSON().components.filter(control => control.type === 3).flatMap(control => control.options.map(option => option.value)), ['discipline']);
    await assert.rejects(f.service.confirm('staff', view.token), /Choose each/);
    await assert.rejects(f.service.exceptions('staff', view.token, ['timing']), /Choose only/);
    const unapproved = f.serviceInput.enqueue({ selections: view.payload.selections, expectedPlanFingerprint: view.payload.fingerprint }, 'unapproved-policy');
    await assert.rejects(f.execute(unapproved), /Choose each/);
    const approved = f.install(await f.service.exceptions('staff', view.token, ['discipline']), view.token);
    message = reinstatementReviewMessage(approved);
    assert.equal(message.components.at(-1)!.components.at(-1)!.toJSON().disabled, false);
    const plan = approved.payload.kind === 'preview' ? structuredClone(approved.payload.plan) : undefined;
    assert.ok(plan);
    plan.reinstatement!.advisories.push({ id: 'roster-count', text: 'Staff may approve the roster-count exception.' });
    const rosterReview = { ...approved, payload: { ...approved.payload, kind: 'preview' as const, plan, selections: view.payload.selections, fingerprint: view.payload.fingerprint } };
    assert.equal(reinstatementReviewMessage(rosterReview).components.at(-1)!.components.at(-1)!.toJSON().disabled, true);
    plan.reinstatement!.selection.overrides.push('roster-count');
    assert.equal(reinstatementReviewMessage(rosterReview).components.at(-1)!.components.at(-1)!.toJSON().disabled, false);
    const job = await f.service.confirm('staff', approved.token);
    await f.execute(job); assert.equal(getLeagueTransaction(f.db, job.reference)!.status, 'completed');
  } finally { f.close(); }
});

test('legacy stored timing markers remain readable provenance and do not create a new required acknowledgement', async () => {
  const f = await fixture();
  try {
    const view = f.install(await f.service.open('staff', 'One'));
    assert.equal(view.payload.kind, 'preview'); if (view.payload.kind !== 'preview') return;
    const selection = { ...parseReinstatementSelection(view.payload.selections)!, overrides: ['timing'] };
    const selections = JSON.stringify(selection);
    const loaded = await f.sheets.load([...f.members.values()], 'fa');
    const plan = await buildVerifiedTransactionIntent({ db: f.db, guildId: 'g', sheets: f.sheets, loaded, selections });
    assert.deepEqual(plan.reinstatement!.advisories, []);
    const job = f.serviceInput.enqueue({ selections, expectedPlanFingerprint: leagueTransactionPlanFingerprint(plan) }, 'legacy-timing-marker');
    await f.execute(job); assert.equal(getLeagueTransaction(f.db, job.reference)!.status, 'completed');
  } finally { f.close(); }
});
