import { buildLeagueAccountReplacementPlan } from '../domain/leagueAccountReplacement.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, TextDisplayBuilder, type ButtonInteraction, type Interaction } from 'discord.js';
import { buildFlowCatalog, createUiRuntime, EventKind, type V2MessagePayload, type V2ModalPayload } from 'fluxcord';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { buildLeagueIntentPlan } from './leagueTransactionIntent.js';
import { createLeagueOpsFlow, leagueCheckDetailPages, type LeagueOpsPanelData } from './leagueOpsFlow.js';
import type { LeagueOpsReviewService, LeagueOpsSnapshot } from './leagueOpsReview.js';
process.env.ROLE_ALLFATHER_ID = 'admin-role';
process.env.ROLE_AESIR_ID = 'staff-role';
const { authorizeLeagueOpsUi, deferredLeagueOpsSender, handleLeagueOpsUi } = await import('./leagueOpsUi.js');

function buttonId(payload: unknown, label: string): string {
  const find = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.label === label && typeof record.custom_id === 'string') return record.custom_id;
    for (const child of Object.values(record)) {
      const found = find(child);
      if (found) return found;
    }
  };
  const found = find(payload);
  assert.ok(found, `Missing rendered button: ${label}`);
  return found;
}
async function until(check: () => boolean) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('UI background work did not settle');
}
async function harness() {
  const source = accountReplacementSources();
  const plan = buildLeagueIntentPlan(JSON.stringify(['trade', 'one', 'two']), (await source.sheets.load([...source.members.values()], 'fa')).snapshot);
  let allowed = true;
  let confirmations = 0;
  let recoveries = 0;
  const repairConfirmations: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const service = {
    authorize: async () => { if (!allowed) throw Error('Revoked'); return 'Admin'; },
    previewTransaction: async () => { await pending; return { originalReference: 'original', selections: 'selected', fingerprint: 'reviewed', approval: 'one-approval', plan }; },
    confirmTransaction: async () => { confirmations++; return { reference: 'new-durable-job', status: 'QUEUED' }; },
    snapshot: async () => snapshot,
    previewRecovery: async () => ({ reference: 'other-recovery', type: 'repair', fingerprint: 'proof', approvalReference: 'approval', description: 'Recovery for a different player', canConfirm: true }),
    confirmRecovery: async () => { recoveries++; return { reference: 'other-recovery', status: 'QUEUED' }; },
    operationDetail: async (_actor: string, reference: string) => ({ ...snapshot.operations[0], reference, status: 'COMPLETED' }),
    previewRepair: async (_actor: string, key: string) => ({ issueKey: key, finding: key, action: 'repair-roles',
      fingerprint: key, approvalReference: key, description: `Fix for ${key}` }),
    confirmRepair: async (_actor: string, preview: { issueKey: string }) => {
      repairConfirmations.push(preview.issueKey); return { reference: 'saved-repair', status: 'QUEUED' };
    },
  } as unknown as LeagueOpsReviewService;
  const flow = createLeagueOpsFlow(service);
  const edits: V2MessagePayload[] = [];
  const validatePayload = (payload: V2MessagePayload) => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (entry.type === 10) new TextDisplayBuilder().setContent(String(entry.content)).toJSON();
      Object.values(entry).forEach(visit);
    };
    visit(payload);
  };
  const copies: string[] = [];
  const modals: V2ModalPayload[] = [];
  let now = 1_000_000;
  const runtime = createUiRuntime({ flows: buildFlowCatalog([{ module: 'league-ops', flow }]), sweeper: false, now: () => now,
    platform: { editMessage: async (_ref, payload) => { validatePayload(payload); edits.push(payload); }, replyToActor: async value => { copies.push(value); },
      showModal: async value => { modals.push(value); }, ack: async () => {} },
    sendToChannel: async () => assert.fail('Private League Ops must never post to a public channel'),
    policy: { authorize: async request => ({ allowed: await authorizeLeagueOpsUi(request, 'g', actor => service.authorize(actor)) }) } });
  const handle = await runtime.mount(flow, { ownerId: 'admin', to: { reply: { send: async payload => { validatePayload(payload); edits.push(payload); return { channelId: 'c', messageId: 'm' }; }, ceilingMs: 15 * 60_000 } } });
  const snapshot: LeagueOpsSnapshot = { issues: [], checkDetails: ['Private check details: 96 picks; Last full check: 8 AM EDT'], operations: [{ reference: 'original', type: 'transaction', status: 'BLOCKED_REVIEW',
    action: 'trade', targets: ['One', 'Two'], actor: 'Dolo', createdAt: '2026-10-11', attempts: 1, error: 'No changes were made.', next: 'Fresh preview', canRepreview: true, canRecover: false }] };
  await handle.redraw(data => { data.snapshot = snapshot; });
  const dispatch = (id: string, actorId = 'admin', guildId = 'g', kind: EventKind = EventKind.Button, inputs?: Record<string, string>) =>
    runtime.dispatch({ customId: id, actorId, guildId, kind, channelId: 'c', messageId: 'm', inputs });
  const click = (label: string, actor = 'admin', guild = 'g') => dispatch(buttonId(edits.at(-1), label), actor, guild);
  const preview = async () => {
    await click('Saved actions'); await click('View action'); await click('Preview player change');
    assert.equal(confirmations, 0);
    // The click finishes while external proof reads remain pending.
    assert.ok(JSON.stringify(edits.at(-1)).includes('Checking the latest league records'));
    release(); await until(() => JSON.stringify(edits.at(-1)).includes('Review these player changes'));
    await click('Approve player change');
  };
  return { snapshot, setData: async (change: (data: LeagueOpsPanelData) => void) => handle.redraw(change), recoveries: () => recoveries, runtime, edits, copies, modals, click, dispatch, preview, release, deny: () => { allowed = false; },
    setIssues: async (issues: LeagueOpsSnapshot['issues']) => { snapshot.issues = issues; await handle.redraw(data => { data.snapshot = snapshot; }); },
    repairConfirmations,
    expire: () => { now += 11 * 60_000; }, count: () => confirmations, close: () => runtime.stopSweeper() };
}

test('real Fluxcord flow releases slow preview work, requires modal confirmation and dedupes duplicate submits', async () => {
  const h = await harness();
  try {
    await h.preview();
    assert.equal(h.count(), 0);
    const id = h.modals.at(-1)!.custom_id;
    await Promise.all([h.dispatch(id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' }),
      h.dispatch(id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' })]);
    await until(() => JSON.stringify(h.edits.at(-1)).includes('new-durable-job'));
    assert.equal(h.count(), 1);
  } finally { h.release(); h.close(); }
});

test('Close panel dismisses a resolved history view without approving another action', async () => {
  const h = await harness();
  try {
    h.snapshot.operations[0] = { ...h.snapshot.operations[0]!, status: 'SUPERSEDED',
      next: 'Resolved by completed-action. The original attempt made no changes.', canRepreview: false, canRecover: false };
    await h.click('Saved actions'); await h.click('View action');
    const payload = JSON.stringify(h.edits.at(-1));
    assert.match(payload, /Resolved by a later action/);
    assert.match(payload, /completed-action/);
    await h.click('Close panel');
    assert.equal(h.count(), 0); assert.equal(h.recoveries(), 0);
    assert.deepEqual(h.repairConfirmations, []);
  } finally { h.release(); h.close(); }
});

test('cancelled previews release the panel for another issue and old modals cannot approve it', async () => {
  const h = await harness();
  try {
    await h.setIssues([{ key: 'first', finding: 'One — Discord division: none; expected: Vanaheim. Make the division role match.' },
      { key: 'second', finding: 'Two — Discord division: none; expected: Vanaheim. Make the division role match.' }]);
    await h.click('View problem');
    await h.click('Set Discord roles from roster sheets');
    await until(() => JSON.stringify(h.edits.at(-1)).includes('Fix for first'));
    await h.click('Set Discord roles from roster sheets');
    const oldModal = h.modals.at(-1)!.custom_id;
    await h.click('Roster problems');
    // Pick the second issue using its separately rendered control.
    const ids: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record.label === 'View problem') ids.push(String(record.custom_id));
      Object.values(record).forEach(visit);
    };
    visit(h.edits.at(-1));
    await h.dispatch(ids[1]!);
    await h.click('Set Discord roles from roster sheets');
    await until(() => JSON.stringify(h.edits.at(-1)).includes('Fix for second'));
    await h.click('Set Discord roles from roster sheets');
    await h.dispatch(oldModal, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' });
    assert.deepEqual(h.repairConfirmations, []);
    await h.dispatch(h.modals.at(-1)!.custom_id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' });
    await until(() => h.repairConfirmations.length === 1);
    assert.deepEqual(h.repairConfirmations, ['second']);
  } finally { h.release(); h.close(); }
});

test('submitted panels can refresh and inspect saved progress without submitting again', async () => {
  const h = await harness();
  try {
    await h.preview();
    await h.dispatch(h.modals.at(-1)!.custom_id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' });
    await until(() => JSON.stringify(h.edits.at(-1)).includes('new-durable-job'));
    await h.click('Saved actions'); await h.click('View action'); await h.click('Refresh');
    await until(() => JSON.stringify(h.edits.at(-1)).includes('Finished'));
    assert.equal(h.count(), 1);
  } finally { h.release(); h.close(); }
});

test('private Fluxcord controls reject another actor, another guild and revoked authorization before queueing', async () => {
  const h = await harness();
  try {
    await h.click('Saved actions', 'other');
    await h.click('Saved actions', 'admin', 'other-guild');
    assert.equal(h.copies.length, 2);
    await h.preview();
    h.deny();
    await h.dispatch(h.modals.at(-1)!.custom_id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' });
    assert.equal(h.count(), 0);
    assert.equal(h.copies.length, 3);
  } finally { h.release(); h.close(); }
});

test('expired Fluxcord modal cannot resume an old approval', async () => {
  const h = await harness();
  try {
    await h.preview(); h.expire();
    await h.dispatch(h.modals.at(-1)!.custom_id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'CONFIRM' });
    assert.equal(h.count(), 0);
    assert.ok(JSON.stringify(h.edits.at(-1)).includes('Use the main button'));
  } finally { h.release(); h.close(); }
});

test('deferred status-card transport edits only its private response, and stale controls do not fall through', async () => {
  let options: unknown;
  const sender = deferredLeagueOpsSender({ createdTimestamp: Date.now(), editReply: async (payload: unknown) => { options = payload; return { id: 'private', channelId: 'c' }; } } as unknown as ButtonInteraction);
  await sender.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [], withResponse: true });
  assert.equal((options as { flags: number }).flags, MessageFlags.IsComponentsV2);
  const replies: Array<{ flags: number; content: string }> = [];
  const interaction = { guildId: 'g', customId: 'ui2:expired:league-ops/review#stamp', isButton: () => true,
    isMessageComponent: () => true, isModalSubmit: () => false, isRepliable: () => true,
    reply: async (value: { flags: number; content: string }) => { replies.push(value); } } as unknown as Interaction;
  assert.equal(await handleLeagueOpsUi(interaction, {}), true);
  assert.equal(replies[0]?.flags, MessageFlags.Ephemeral);
  assert.match(replies[0]!.content, /expired|starting up/);
});


test('switching from account replacement to saved recovery shows and confirms only the recovery', async () => {
  const h = await harness();
  try {
    const f = accountReplacementSources();
    const snapshot = (await f.sheets.load([...f.members.values()], 'fa')).snapshot;
    const plan = buildLeagueAccountReplacementPlan({ guildId: 'g', snapshot, oldDiscordId: 'one', newDiscordId: 'new', oldMember: null, newMember: f.members.get('new')!, newNameSheetRow: 20 });
    await h.setData(data => { data.replacement = { plan, fingerprint: 'old-proof', approvalReference: 'old-approval', preservedJobReferences: [], draftVerification: 'verified' }; data.samePlayerConfirmed = true; });
    h.snapshot.operations[0]!.canRecover = true;
    await h.click('Saved actions'); await h.click('View action'); await h.click('Check unfinished changes');
    await until(() => JSON.stringify(h.edits.at(-1)).includes('Close checked action'));
    assert.match(JSON.stringify(h.edits.at(-1)), /Recovery for a different player/);
    assert.doesNotMatch(JSON.stringify(h.edits.at(-1)), /Move One to their new Discord account/);
    await h.click('Close checked action');
    assert.match(JSON.stringify(h.modals.at(-1)), /Recovery for a different player/);
    assert.doesNotMatch(JSON.stringify(h.modals.at(-1)), /Move One to their new Discord account/);
    await h.dispatch(h.modals.at(-1)!.custom_id, 'admin', 'g', EventKind.ModalSubmit, { confirm: 'HISTORY REVIEWED' });
    await until(() => h.recoveries() === 1);
    assert.equal(h.count(), 0);
    assert.deepEqual(h.repairConfirmations, []);
  } finally { h.release(); h.close(); }
});


test('check details are reachable in the private flow without approving a change', async () => {
  const h = await harness();
  try {
    await h.click('Check details');
    assert.match(JSON.stringify(h.edits.at(-1)), /Private check details: 96 picks/);
    assert.equal(h.count(), 0);
    assert.equal(h.recoveries(), 0);
    assert.deepEqual(h.repairConfirmations, []);
    await h.click('Roster problems');
    assert.match(JSON.stringify(h.edits.at(-1)), /No roster problems found/);
  } finally { h.release(); h.close(); }
});


test('long private details remain reachable through bounded pages without discarding draft guidance', async () => {
  const h = await harness();
  try {
    const details = Array.from({ length: 30 }, (_, index) => `Roster problem ${index}: ` + 'Check the sheet values. '.repeat(7));
    details.push('Draft Picks is missing. Ask an admin to check its setup.', 'Last full roster check: 8 AM EDT');
    const pages = leagueCheckDetailPages(details);
    assert.equal(pages.join(''), details.join('\n\n'));
    assert.ok(pages.every(page => page.length <= 1400));
    await h.setData(data => { data.snapshot.checkDetails = details; });
    await h.click('Check details');
    for (let index = 1; index < pages.length; index++) await h.click('Next details');
    assert.match(JSON.stringify(h.edits.at(-1)), /Draft Picks is missing/);
    assert.match(JSON.stringify(h.edits.at(-1)), /Last full roster check/);
    await h.click('Previous details');
    assert.equal(h.count(), 0);
    assert.deepEqual(h.repairConfirmations, []);
  } finally { h.release(); h.close(); }
});


test('private pagination redacts complete credentials before splitting across a page boundary', async () => {
  const key = 'SNAPSHOT_BOUNDARY_TEST_TOKEN';
  const old = process.env[key];
  const secret = 'synthetic-boundary-secret-for-regression';
  process.env[key] = secret;
  const h = await harness();
  try {
    const details = ['x'.repeat(1390) + secret + ' visible next step'];
    const pages = leagueCheckDetailPages(details);
    assert.doesNotMatch(pages.join(''), /synthetic-boundary-secret-for-regression/);
    assert.match(pages.join(''), /REDACTED/);
    await h.setData(data => { data.snapshot.checkDetails = details; });
    await h.click('Check details');
    const rendered = [JSON.stringify(h.edits.at(-1))];
    for (let page = 1; page < pages.length; page++) { await h.click('Next details'); rendered.push(JSON.stringify(h.edits.at(-1))); }
    assert.doesNotMatch(rendered.join(''), /synthetic|boundary-secret/);
    assert.match(rendered.join(''), /visible next step/);
  } finally { h.release(); h.close(); if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});
