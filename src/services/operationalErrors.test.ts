import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { openDatabase, insertManagedResource } from '../db/index.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';
import { handleInteractionError, interactionOperationContext } from './interactionErrors.js';

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

function fixture() {
  const db = openDatabase(':memory:');
  const sent: any[] = [];
  const roles = new Collection<string, any>([
    ['guild', { id: 'guild', permissions: new PermissionsBitField() }],
    ['staff', { id: 'staff', permissions: new PermissionsBitField() }],
    ['player', { id: 'player', permissions: new PermissionsBitField() }],
  ]);
  let publicChannel = false;
  let playersAllowed = false;
  let sendAllowed = true;
  let failSend = false;
  let missing = false;
  const bot = { id: 'bot' };
  const guild = { id: 'guild', roles: { everyone: roles.get('guild'), cache: roles, fetch: async () => roles }, members: { me: bot } };
  const channel = { type: ChannelType.GuildText, guild,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: (target: any) => new PermissionsBitField(target.id === 'bot'
      ? sendAllowed ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : []
      : target.id === 'staff' || (target.id === 'guild' && publicChannel) || (target.id === 'player' && playersAllowed)
        ? [PermissionFlagsBits.ViewChannel] : []),
    send: async (payload: any) => { if (failSend) throw new Error('Forbidden'); sent.push(payload); },
  };
  const client = { user: bot, channels: { fetch: async (id: string) => { assert.equal(id, 'staff-ops'); return missing ? null : channel; } } } as unknown as Client;
  insertManagedResource(db, { guildId: 'guild', discordResourceId: 'staff-ops', resourceType: 'text_channel', scaffoldDomain: 'server', logicalKey: 'server:channel:admin:staff_ops:text_channel' });
  insertManagedResource(db, { guildId: 'guild', discordResourceId: 'staff', resourceType: 'role', scaffoldDomain: 'server', logicalKey: 'server:role:valkyries' });
  return { db, client, sent, channel,
    set: (which: string) => { publicChannel = which === 'public'; playersAllowed = which === 'players'; sendAllowed = which !== 'denied'; failSend = which === 'failure'; missing = which === 'missing'; } };
}

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
