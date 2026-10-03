import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { openDatabase, insertManagedResource } from '../db/index.js';
import {
  createLeagueTransaction,
  createOrGetLeagueReconciliationTicket,
  getLeagueTransaction,
  getLeagueReconciliationTicket,
  markLeagueTransactionReconciliationRequired,
  transitionLeagueTransaction,
} from '../db/repositories/leagueOperations.js';
import { getValidatedStaffChannel, reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';
import {
  handleInteractionError,
  interactionOperationContext,
  leagueTransactionReconciliationContext,
} from './interactionErrors.js';
import { LeagueReconciliationTicketError } from './leagueTransactions.js';

test('nested Scout failures identify their setup and operation without confusing division or page IDs', () => {
  const context = (customId: string, values: string[] = []) => interactionOperationContext({
    customId, values, guildId: 'guild', isChatInputCommand: () => false,
  } as any, 'fallback');
  assert.equal(context('scout:editpick:swapfirst:12:3').setupId, 12);
  assert.notEqual(context('scout:editpick:swapfirst:12:3').action, context('scout:editpick:replacefirst:12:3').action);
  assert.notEqual(context('scout:publishedswap:12:3').action, context('scout:publishedreplace:12:3').action);
  assert.equal(context('scout:cancelpick:all', ['42:7']).setupId, 42);
  assert.equal(context('scout:cancelpick:9', ['42']).setupId, 42);
  assert.equal(context('scout:cancelpage:2').setupId, undefined);
  assert.equal(context('scout:create:post:draft-id').setupId, undefined);
  assert.equal(context('scout:edituser:explicit:12:3:45').setupId, 12);
  assert.equal(context('scout:publishedswap:invalid:3').setupId, undefined);
});

test('startup transaction recovery includes partial-state manual-repair guidance', () => {
  const context = leagueTransactionReconciliationContext('guild', 'Sheet verification failed.');
  assert.equal(context.action, 'League transaction reconciliation');
  assert.match(context.next ?? '', /Sheet verification failed/);
  assert.match(context.next ?? '', /reconcile them manually/);
  assert.match(context.next ?? '', /do not retry/i);
});

test('unexpected failure acknowledges privately before staff lookup and reports even if the token expires', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  let acknowledged = false;
  let expired = false;
  const replies: any[] = [];
  const originalFetch = f.client.channels.fetch.bind(f.client.channels);
  t.mock.method(f.client.channels, 'fetch', async (...args: any[]) => {
    assert.equal(acknowledged, true, 'staff lookup must follow acknowledgement');
    return originalFetch(...args as [any, any]);
  });
  const interaction: any = { client: f.client, guildId: 'guild', customId: 'scout:editpick:swapfirst:12:3',
    isChatInputCommand: () => false, isRepliable: () => true, replied: false, deferred: false,
    deferReply: async (payload: any) => { acknowledged = true; assert.equal(payload.flags, 64); if (expired) throw new Error('Expired'); interaction.deferred = true; },
    editReply: async (payload: any) => { replies.push(payload); },
    reply: async () => { throw new Error('Expired'); },
  };
  try {
    await handleInteractionError(interaction, f.db, new Error('first failure'), 'guild');
    assert.equal(f.sent.length, 1);
    assert.ok(replies[0].content.includes('Staff were notified'));
    assert.match(f.sent[0].content, /Setup #12/);
    expired = true; acknowledged = false; interaction.deferred = false;
    interaction.customId = 'scout:editpick:swapfirst:13:3';
    await handleInteractionError(interaction, f.db, new Error('second failure'), 'guild');
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].content, /Setup #13/);
  } finally { f.db.close(); }
});

test('a delivered league reconciliation ticket is marked alerted and gives staff manual-repair guidance', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  createOrGetLeagueReconciliationTicket(f.db, {
    reference: 'YSL-REC-TEST', guildId: 'guild', actorUserId: 'admin', fingerprint: 'fingerprint', summary: 'Roster drift.',
  });
  const interaction: any = {
    client: f.client, guildId: 'guild', isChatInputCommand: () => true, commandName: 'transaction',
    options: { getSubcommand: () => 'trade' }, isRepliable: () => true, replied: false, deferred: false,
    deferReply: async () => { interaction.deferred = true; }, editReply: async () => undefined,
  };
  await handleInteractionError(
    interaction,
    f.db,
    new LeagueReconciliationTicketError('Ratatoskr made no changes. Reconcile league data, then retry.', 'YSL-REC-TEST'),
    'guild',
  );
  assert.ok(getLeagueReconciliationTicket(f.db, 'YSL-REC-TEST')?.alertedAt);
  assert.match(f.sent[0].content, /League sheet reconciliation/);
  assert.match(f.sent[0].content, /Ratatoskr made no changes/);
  f.db.close();
});

test('a delivered immediate transaction reconciliation alert is not retried on restart', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  createLeagueTransaction(f.db, {
    reference: 'YSL-TRX-TEST', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload: {},
  });
  markLeagueTransactionReconciliationRequired(f.db, 'YSL-TRX-TEST', 'Discord rollback failed.');
  const interaction: any = {
    client: f.client, guildId: 'guild', isChatInputCommand: () => true, commandName: 'transaction',
    options: { getSubcommand: () => 'trade' }, isRepliable: () => true, replied: false, deferred: false,
    deferReply: async () => { interaction.deferred = true; }, editReply: async () => undefined,
  };
  const error = Object.assign(new Error('Discord rollback failed.'), { reference: 'YSL-TRX-TEST' });
  await handleInteractionError(interaction, f.db, error, 'guild');
  assert.ok(getLeagueTransaction(f.db, 'YSL-TRX-TEST')?.reconciliationAlertedAt);
  assert.match(f.sent[0].content, /League transaction reconciliation/);
  assert.match(f.sent[0].content, /Discord rollback failed/);
  assert.match(f.sent[0].content, /reconcile them manually/);
  assert.match(f.sent[0].content, /do not retry/i);
  f.db.close();
});

test('a safely failed transaction reports without requiring message history', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  createLeagueTransaction(f.db, {
    reference: 'YSL-TRX-FAILED', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload: {},
  });
  transitionLeagueTransaction(f.db, 'YSL-TRX-FAILED', 'applying_discord', 'failed', { errorMessage: 'Rolled back.' });
  f.set('no-history');
  const interaction: any = {
    client: f.client, guildId: 'guild', isChatInputCommand: () => true, commandName: 'transaction',
    options: { getSubcommand: () => 'trade' }, isRepliable: () => true, replied: false, deferred: false,
    deferReply: async () => { interaction.deferred = true; }, editReply: async () => undefined,
  };
  await handleInteractionError(
    interaction,
    f.db,
    Object.assign(new Error('Rolled back safely.'), { reference: 'YSL-TRX-FAILED' }),
    'guild',
  );
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /Reference:/);
  f.db.close();
});

function fixture() {
  const db = openDatabase(':memory:');
  const sent: any[] = [];
  const attempted: any[] = [];
  const roles = new Collection<string, any>([
    ['guild', { id: 'guild', name: '@everyone', permissions: new PermissionsBitField() }],
    ['staff', { id: 'staff', name: 'Valkyries', permissions: new PermissionsBitField() }],
    ['production', { id: 'production', name: 'Norns', permissions: new PermissionsBitField() }],
    ['player', { id: 'player', name: 'League Players', permissions: new PermissionsBitField() }],
  ]);
  let publicChannel = false;
  let playersAllowed = false;
  let productionAllowed = false;
  let sendAllowed = true;
  let readHistoryAllowed = true;
  let failSend = false;
  let loseSendResponse = false;
  let missing = false;
  const bot = { id: 'bot' };
  const guild = { id: 'guild', roles: { everyone: roles.get('guild'), cache: roles, fetch: async () => roles }, members: { me: bot } };
  const channel = { type: ChannelType.GuildText, guild,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: (target: any) => new PermissionsBitField(target.id === 'bot'
      ? sendAllowed ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        ...(readHistoryAllowed ? [PermissionFlagsBits.ReadMessageHistory] : [])] : []
      : target.id === 'staff' || (target.id === 'guild' && publicChannel) || (target.id === 'player' && playersAllowed)
        || (target.id === 'production' && productionAllowed)
        ? [PermissionFlagsBits.ViewChannel] : []),
    messages: { fetch: async ({ limit, before }: { limit: number; before?: string }) => {
      const rows = [...history.values()]
        .filter((message) => before === undefined || Number(message.id) < Number(before))
        .sort((left, right) => Number(right.id) - Number(left.id))
        .slice(0, limit);
      return new Collection(rows.map((message) => [message.id, message]));
    } },
    send: async (payload: any) => {
      attempted.push(payload);
      if (failSend) throw new Error('Forbidden');
      sent.push(payload);
      const message = { id: String(++nextMessageId), author: bot, content: payload.content, nonce: payload.nonce };
      history.set(message.id, message);
      if (loseSendResponse) throw new Error('Response lost');
      return message;
    },
  };
  let nextMessageId = 0;
  const history = new Collection<string, any>();
  const client = { user: bot, channels: { fetch: async (id: string) => { assert.equal(id, 'staff-ops'); return missing ? null : channel; } } } as unknown as Client;
  insertManagedResource(db, { guildId: 'guild', discordResourceId: 'staff-ops', resourceType: 'text_channel', scaffoldDomain: 'server', logicalKey: 'server:channel:admin:staff_ops:text_channel' });
  insertManagedResource(db, { guildId: 'guild', discordResourceId: 'staff', resourceType: 'role', scaffoldDomain: 'server', logicalKey: 'server:role:valkyries' });
  return { db, client, sent, attempted, channel,
    addHistory: (content: string) => {
      const message = { id: String(++nextMessageId), author: bot, content, nonce: null };
      history.set(message.id, message);
    },
    set: (which: string) => {
      publicChannel = which === 'public';
      playersAllowed = which === 'players';
      productionAllowed = which === 'production';
      sendAllowed = which !== 'denied';
      readHistoryAllowed = which !== 'no-history';
      failSend = which === 'failure';
      loseSendResponse = which === 'lost-response';
      missing = which === 'missing';
    } };
}

test('staff-ops accepts the managed Production identity after its Discord role is renamed to Norns', async () => {
  const f = fixture();
  try {
    f.set('production');
    await assert.rejects(getValidatedStaffChannel(f.client, f.db, 'guild'), /non-staff role/);
    insertManagedResource(f.db, {
      guildId: 'guild', discordResourceId: 'production', resourceType: 'role',
      scaffoldDomain: 'server', logicalKey: 'server:role:production',
    });
    assert.equal(await getValidatedStaffChannel(f.client, f.db, 'guild'), f.channel);
  } finally { f.db.close(); }
});

test('unsafe staff-ops role diagnostics name the exact role and stable Discord ID', async () => {
  const f = fixture();
  try {
    f.set('players');
    await assert.rejects(
      getValidatedStaffChannel(f.client, f.db, 'guild'),
      /staff-ops permits a non-staff role: League Players \(player\)/,
    );
  } finally { f.db.close(); }
});

test('operational report shares a reference, redacts credentials and suppresses repeated staff alerts', async (t) => {
  const f = fixture();
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const before = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'test-secret-token';
  try {
    const context = { guildId: 'guild', action: 'Published swap', setupId: 12, division: '@everyone', next: 'Inspect pending setup.' };
    const report = await reportOperationalError(f.client, f.db, context, new Error('test-secret-token at postgres://user:password@host/db'));
    assert.equal(report.staffDelivered, true);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
    assert.ok(f.sent[0].content.includes(report.reference));
    assert.ok(logs[0]!.includes(report.reference));
    assert.ok(!logs.join('').includes('test-secret-token'));
    assert.ok(!logs.join('').includes('user:password'));
    assert.ok(!f.sent[0].content.includes('postgres'));
    const duplicate = await reportOperationalError(f.client, f.db, context, new Error('again'));
    assert.equal(duplicate.reference, report.reference);
    assert.equal(f.sent.length, 1);
    assert.match(operationalErrorGuidance(report), /Staff were notified/);
  } finally { if (before === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = before; f.db.close(); }
});

test('a lifecycle staff report retries failed delivery with a stable reference and nonce', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  try {
    const context = { guildId: 'guild', action: 'Automatic Scout cancellation cleanup', setupId: 12 };
    const options = { reference: 'lifecycle-reference', retryUndelivered: true } as const;
    f.set('missing');
    const failed = await reportOperationalError(f.client, f.db, context, new Error('Discord edit failed'), options);
    assert.equal(failed.staffDelivered, false);
    assert.equal(failed.reference, options.reference);

    f.set('failure');
    const uncertain = await reportOperationalError(f.client, f.db, context, new Error('Discord edit failed'), options);
    assert.equal(uncertain.staffDelivered, false);

    f.set('available');
    const delivered = await reportOperationalError(f.client, f.db, context, new Error('Discord edit failed'), options);
    assert.equal(delivered.staffDelivered, true);
    assert.equal(failed.staffDelivered, false, 'a prior failed result stays truthful after a later retry');
    assert.equal(delivered.reference, options.reference);
    assert.equal(f.sent.length, 1);
    assert.equal(f.attempted.length, 2);
    assert.equal(f.sent[0].enforceNonce, true);
    assert.match(f.sent[0].nonce, /^[a-f0-9]{24}$/);
    assert.equal(f.attempted[0].nonce, f.attempted[1].nonce);
    assert.match(f.sent[0].content, /Reference: lifecycle-reference/);

    await reportOperationalError(f.client, f.db, context, new Error('Discord edit failed'), options);
    assert.equal(f.sent.length, 1);
  } finally { f.db.close(); }
});

test('a delayed staff-report retry finds an accepted message after its send response was lost', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  const context = { guildId: 'guild', action: 'League transaction reconciliation' };
  const options = { reference: 'YSL-TRX-LOST-RESPONSE', retryUndelivered: true } as const;
  try {
    f.set('lost-response');
    const uncertain = await reportOperationalError(f.client, f.db, context, new Error('Response lost'), options);
    assert.equal(uncertain.staffDelivered, false);
    assert.equal(f.sent.length, 1);
    for (let index = 0; index < 105; index += 1) f.addHistory(`Later staff message ${index}`);

    f.set('available');
    const recovered = await reportOperationalError(f.client, f.db, context, new Error('Response lost'), options);
    assert.equal(recovered.staffDelivered, true);
    assert.equal(f.sent.length, 1, 'history recovery must not send a duplicate alert');
    assert.equal(f.attempted.length, 1);
  } finally { f.db.close(); }
});

test('ordinary alerts remain deliverable without message history while durable retries fail safely', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  try {
    f.set('no-history');
    const ordinary = await reportOperationalError(
      f.client, f.db, { guildId: 'guild', action: 'Ordinary failure' }, new Error('Failed'),
    );
    assert.equal(ordinary.staffDelivered, true);
    const durable = await reportOperationalError(
      f.client,
      f.db,
      { guildId: 'guild', action: 'Durable recovery' },
      new Error('Failed'),
      { reference: 'durable-reference', retryUndelivered: true },
    );
    assert.equal(durable.staffDelivered, false);
    assert.equal(f.sent.length, 1);
  } finally { f.db.close(); }
});

test('staff reporting falls back to STAFF_OPS_CHANNEL_ID when the channel is not a managed resource', async (t) => {
  const f = fixture();
  t.mock.method(console, 'error', () => undefined);
  const before = process.env.STAFF_OPS_CHANNEL_ID;
  process.env.STAFF_OPS_CHANNEL_ID = 'staff-ops';
  try {
    f.db.prepare("DELETE FROM managed_resources WHERE logical_key = 'server:channel:admin:staff_ops:text_channel'").run();
    // The env schema is parsed once at import; re-import with a cache-busting
    // query so this module instance picks up the value set just above.
    const fresh = await import(`./operationalErrors.js?staff-ops-channel-id-test=${Date.now()}`);
    const report = await fresh.reportOperationalError(f.client, f.db, { guildId: 'guild', action: 'Swap' }, new Error('original failure'));
    assert.equal(report.staffDelivered, true);
    assert.equal(f.sent.length, 1);
  } finally {
    if (before === undefined) delete process.env.STAFF_OPS_CHANNEL_ID; else process.env.STAFF_OPS_CHANNEL_ID = before;
    f.db.close();
  }
});

for (const failure of ['public', 'players', 'denied', 'failure', 'missing', 'wrong-guild', 'unbound']) {
  test(`staff reporting has a truthful non-recursive fallback for ${failure}`, async (t) => {
    const f = fixture();
    t.mock.method(console, 'error', () => undefined);
    try {
      f.set(failure);
      if (failure === 'wrong-guild') f.channel.guild.id = 'other';
      if (failure === 'unbound') f.db.prepare('DELETE FROM managed_resources').run();
      const report = await reportOperationalError(f.client, f.db, { guildId: 'guild', action: 'Swap' }, new Error('original failure'));
      assert.equal(report.staffDelivered, false);
      assert.equal(f.sent.length, 0);
      assert.match(operationalErrorGuidance(report), /could not be confirmed.*Railway/);
      assert.ok(report.reference);
    } finally { f.db.close(); }
  });
}
