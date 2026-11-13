import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlowCatalog, createUiRuntime, EventKind, type V2MessagePayload, type V2ModalPayload } from 'fluxcord';
import { openDatabase } from '../db/client.js';
import { replaceFullLeagueFindings } from '../db/repositories/leagueVerifiedState.js';
import { beginDirtyLeagueAudit } from '../db/repositories/leagueAudits.js';
import { auditLeagueRoster } from '../domain/leagueOperations.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { LeagueAccountReplacementService } from './leagueAccountReplacement.js';
import { LeagueJobWorker, type LeagueJobHandler } from './leagueJobWorker.js';
import { LeagueOpsReviewService } from './leagueOpsReview.js';
import { buildLeagueIntentPlan } from './leagueTransactionIntent.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { previewLeagueAuditResolution } from './leagueAuditResolution.js';
import { createLeagueOpsFlow } from './leagueOpsFlow.js';
import { leagueFindingKind } from './leagueAuditPresentation.js';
import { executeLeagueAuditRepair } from './leagueAuditResolution.js';
import { type LeagueJobType, getLeagueJob } from '../db/repositories/leagueJobs.js';

async function leagueOpsReviewFixture() {
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

type Fixture = Awaited<ReturnType<typeof leagueOpsReviewFixture>>;
const replacementLabel = 'Player changed Discord account';
const newId = '123456789012345678';
const inactiveLabel = 'They left — mark them inactive';
function controls(payload: unknown): Array<{ label: string; custom_id: string }> {
  if (!payload || typeof payload !== 'object') return [];
  const value = payload as Record<string, unknown>;
  return [...(typeof value.label === 'string' && typeof value.custom_id === 'string'
    ? [{ label: value.label, custom_id: value.custom_id }] : []), ...Object.values(value).flatMap(controls)];
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Review did not settle');
}
function configure(f: Fixture, layered: boolean, freeAgent: boolean) {
  const g = f.gateway;
  const replacement = f.members.get('new')!;
  f.members.delete('new'); replacement.discordId = newId; f.members.set(newId, replacement);
  for (const tab of ['League Teams', 'Current Rosters', 'Player Name History'])
    for (const row of g.rows('admin', tab)) row.forEach((cell, index) => { if (cell === 'Vanaheim') row[index] = 'Svartalfheim'; });
  g.data.set('public:Svartalfheim Roster', g.rows('public', 'Vanaheim Roster'));
  g.data.set('public:Vanaheim Roster', Array.from({ length: 99 }, () => Array(15).fill('')));
  if (freeAgent) {
    g.rows('admin', 'Current Rosters')[5] = [];
    g.rows('admin', 'Player Name History')[5]![5] = '';
    g.rows('admin', 'Player Name History')[5]![6] = 'Free Agent';
    g.rows('public', 'Svartalfheim Roster')[4]![2] = '';
    g.rows('public', 'Svartalfheim Roster')[24]![5] = 'One';
  }
  if (layered) {
    g.rows('admin', 'League Teams').push(['n', 'Dream Walkers', 'Niflheim', 'n', 'Dream Walkers ND', '', '', 'division-n', '', 'nif-captain', '', 'Yes']);
    g.rows('admin', 'Current Rosters').push(['Niflheim', 'Dream Walkers', 'n', 'Dream Walkers ND', 'one', 'One', 'Captain']);
    const grid = Array.from({ length: 99 }, () => Array(15).fill(''));
    grid[4]![2] = 'One'; g.data.set('public:Niflheim Roster', grid);
  }
}
async function panel(f: Fixture, issueKey: string) {
  const snapshot = await f.service.snapshot('admin');
  const edits: V2MessagePayload[] = []; const modals: V2ModalPayload[] = [];
  const flow = createLeagueOpsFlow(f.service);
  const runtime = createUiRuntime({ flows: buildFlowCatalog([{ module: 'league-ops', flow }]), sweeper: false,
    platform: { editMessage: async (_ref, payload) => { edits.push(payload); }, replyToActor: async () => {},
      showModal: async value => { modals.push(value); }, ack: async () => {} },
    sendToChannel: async () => assert.fail('Review must remain private'),
    policy: { authorize: async () => { await f.service.authorize('admin'); return { allowed: true }; } } });
  const handle = await runtime.mount(flow, { ownerId: 'admin', to: { reply: {
    send: async payload => { edits.push(payload); return { channelId: 'c', messageId: 'm' }; }, ceilingMs: 15 * 60_000 } } });
  await handle.redraw(data => { data.snapshot = snapshot; data.selectedIssue = snapshot.issues.find(issue => issue.key === issueKey); });
  // Select via the actual list control; there are fewer than five findings in valid fixtures.
  const index = snapshot.issues.findIndex(issue => issue.key === issueKey);
  if (index >= 5) await handle.redraw(data => { data.page = Math.floor(index / 5); });
  const dispatch = (customId: string, kind: EventKind = EventKind.Button, inputs?: Record<string, string>) => runtime.dispatch({
    customId, actorId: 'admin', guildId: 'g', kind, channelId: 'c', messageId: 'm', inputs });
  await dispatch(controls(edits.at(-1)).filter(control => control.label === 'View problem')[index % 5]!.custom_id);
  return { edits, modals, runtime, dispatch, click: async (label: string) => {
    const button = controls(edits.at(-1)).find(control => control.label === label); assert.ok(button, label); await dispatch(button.custom_id);
  } };
}

for (const layered of [false, true]) for (const freeAgent of [false, true]) {
  test(`persisted finding → rendered action → canonical preview: layered=${layered}, freeAgent=${freeAgent}`, async () => {
    const f = await leagueOpsReviewFixture(); let ui: Awaited<ReturnType<typeof panel>> | undefined;
    try {
      configure(f, layered, freeAgent); await f.recheck();
      let memberReads = 0;
      const read = f.discord.getAccountReplacementMembers;
      f.discord.getAccountReplacementMembers = async () => { memberReads++; return read(); };
      const snapshot = await f.service.snapshot('admin');
      const issue = snapshot.issues.find(issue => leagueFindingKind(issue.finding) === (freeAgent ? 'departed-free-agent' : 'departed'))!;
      assert.ok(issue); assert.equal(issue.oldDiscordId, freeAgent ? undefined : 'one');
      assert.equal(issue.requiresManualReview, undefined);
      ui = await panel(f, issue.key);
      const labels = controls(ui.edits.at(-1)).map(control => control.label);
      assert.equal(labels.includes(replacementLabel), !freeAgent);
      assert.equal(labels.includes(inactiveLabel), freeAgent);
      assert.equal(memberReads, 0, 'Classification/rendering must not read the whole guild');
      if (!freeAgent) {
        await ui.click(replacementLabel);
        await ui.dispatch(ui.modals.at(-1)!.custom_id, EventKind.ModalSubmit, { old: 'one', new: newId, attestation: 'WRONG' });
        assert.equal(memberReads, 0); assert.equal(f.gateway.writes.length, 0);
        await ui.click(replacementLabel);
        await ui.dispatch(ui.modals.at(-1)!.custom_id, EventKind.ModalSubmit, { old: 'one', new: newId, attestation: 'SAME PLAYER' });
        await until(() => JSON.stringify(ui!.edits.at(-1)).includes('Review the account change'));
        assert.equal(memberReads, 1);
        const preview = await f.service.previewReplacement('admin', issue.key, 'one', newId);
        assert.equal(preview.plan.rosterAfter.rosterStatus, 'Captain');
        assert.equal(!!preview.plan.layeredAfter, layered);
        assert.equal(f.gateway.writes.length, 0);
        const job = await f.service.confirmReplacement('admin', preview, true);
        assert.equal((await f.service.confirmReplacement('admin', preview, true)).reference, job.reference);
        f.worker.start();
        await until(() => getLeagueJob(f.db, job.reference)?.status === 'COMPLETED');
        const loaded = await f.sheets.load([...f.members.values()], 'fa');
        assert.equal(loaded.snapshot.rosters.filter(row => row.discordId === newId).length, layered ? 2 : 1);
        assert.ok(f.gateway.rows('admin', 'Player Name History').some(row => row[0] === 'one' && row[3] === 'Previous / Alternate'));
        if (layered) assert.ok(f.members.get(newId)!.roleIds.includes('n'));
      } else {
        await assert.rejects(() => f.service.previewReplacement('admin', issue.key, 'one', newId), /problem changed/);
        await ui.click(inactiveLabel);
        await until(() => JSON.stringify(ui!.edits.at(-1)).includes('Rat checks everything again'));
        const preview = await f.service.previewRepair('admin', issue.key);
        assert.equal(preview.action, 'mark-inactive'); assert.equal(f.gateway.writes.length, 0);
        const job = await f.service.confirmRepair('admin', preview);
        await executeLeagueAuditRepair({ db: f.db, operationScope: f.db, guildId: 'g', actorUserId: 'admin', actorName: 'Admin',
          now: new Date(), auditReference: 'audit', expectedFinding: preview.finding, expectedRepairFingerprint: preview.fingerprint,
          action: preview.action, freeAgentRoleId: 'fa', jobReference: job.reference, sheets: f.sheets,
          members: { getMembers: async () => [...f.members.values()] },
          authorizeBeforeWrite: async () => { await f.service.authorize('admin'); },
          discord: { validateDisplayName: async () => {}, reconcileManagedRoles: async () => assert.fail('No role write for absent player') } });
        const loaded = await f.sheets.load([...f.members.values()], 'fa');
        assert.equal(loaded.snapshot.rosters.some(row => row.discordId === 'one'), false);
        assert.equal(loaded.snapshot.names.find(row => row.discordId === 'one' && row.nameStatus === 'Current Discord Name')!.leagueStatus, 'Inactive');
        assert.equal(memberReads, 0);
      }
    } finally { ui?.runtime.stopSweeper(); f.close(); }
  });
}

for (const invalid of ['missing-name', 'duplicate-name', 'duplicate-primary', 'duplicate-layered', 'wrong-parent', 'status-mismatch', 'missing-primary'] as const) {
  test(`invalid membership offers no mutation and rejects preview: ${invalid}`, async () => {
    const f = await leagueOpsReviewFixture(); let ui: Awaited<ReturnType<typeof panel>> | undefined;
    try {
      configure(f, true, false);
      const names = f.gateway.rows('admin', 'Player Name History');
      const rosters = f.gateway.rows('admin', 'Current Rosters');
      if (invalid === 'missing-name') names[5]![3] = 'Previous / Alternate';
      if (invalid === 'duplicate-name') names.push([...names[5]!]);
      if (invalid === 'duplicate-primary') rosters.push([...rosters[5]!]);
      if (invalid === 'duplicate-layered') rosters.push([...rosters.at(-1)!]);
      if (invalid === 'wrong-parent') { names[5]![4] = 'Alfheim'; rosters[5]![0] = 'Alfheim'; }
      if (invalid === 'status-mismatch') names[5]![6] = 'Inactive';
      if (invalid === 'missing-primary') rosters[5] = [];
      await f.recheck();
      const issues = (await f.service.snapshot('admin')).issues.filter(issue => issue.key.startsWith('member:one:'));
      assert.ok(issues.length);
      for (const issue of issues) {
        assert.equal(issue.oldDiscordId, undefined); assert.equal(issue.requiresManualReview, true);
        await assert.rejects(() => f.service.previewReplacement('admin', issue.key, 'one', newId));
        await assert.rejects(() => f.service.previewRepair('admin', issue.key));
      }
      ui = await panel(f, issues[0]!.key);
      const labels = controls(ui.edits.at(-1)).map(control => control.label);
      assert.equal(labels.includes(replacementLabel), false); assert.equal(labels.includes(inactiveLabel), false);
      assert.equal(labels.some(label => label.includes('right —')), false);
      assert.equal(f.gateway.writes.length, 0); assert.equal(f.roleWrites, 0);
    } finally { ui?.runtime.stopSweeper(); f.close(); }
  });
}
