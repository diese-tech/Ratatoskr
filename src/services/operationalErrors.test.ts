import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { openDatabase, insertManagedResource } from '../db/index.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';

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
