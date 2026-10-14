import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, ChannelType, PermissionsBitField, type Guild } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { getInhouseConfig } from '../db/repositories/inhouse.js';
import { setupInhouses } from './inhouseSetup.js';

function fixture() {
  const db = openDatabase(':memory:');
  const input = { guildId: 'guild', categoryId: 'permanent', categoryName: 'Midgard',
    roleName: 'Inhouse', channelName: 'inhouses', emoji: '🎮' };
  const permissions = new PermissionsBitField(PermissionsBitField.All);
  const overwrites = new Collection<string, any>([['everyone', { id: 'everyone', type: 0,
    allow: new PermissionsBitField(0n), deny: new PermissionsBitField(PermissionsBitField.Flags.ViewChannel) }]]);
  const category = { id: 'permanent', name: 'Midgard', type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: overwrites }, permissionsFor: () => permissions };
  const roles = new Collection<string, any>();
  const channels = new Collection<string, any>([[category.id, category]]);
  const messages = new Collection<string, any>();
  const creates: any[] = [];
  let lostSend = false;
  const guild = { id: 'guild', client: { user: { id: 'rat' } },
    members: { fetchMe: async () => ({ permissions }) },
    fetchAuditLogs: async () => ({ entries: new Collection() }),
    roles: { fetch: async () => roles, create: async (options: any) => {
      creates.push(options);
      const role = { id: 'inhouse-role', name: options.name, position: 1, managed: false, editable: true,
        permissions: new PermissionsBitField(options.permissions) };
      roles.set(role.id, role); return role;
    } },
    channels: { fetch: async () => channels, create: async (options: any) => {
      creates.push(options);
      const channel = { id: 'inhouses', name: options.name, type: options.type, parentId: options.parent,
        permissionsFor: () => permissions, permissionOverwrites: { cache: overwrites },
        messages: { fetch: async (query: any) => typeof query === 'string' ? messages.get(query) : messages },
        send: async (payload: any) => {
          creates.push(payload);
          const message = { id: 'optin', author: { id: 'rat' }, components: payload.components.map((row: any) => ({
            components: row.toJSON().components.map((component: any) => ({ customId: component.custom_id })),
          })), pinned: false, react: async () => {}, pin: async () => { message.pinned = true; } };
          messages.set(message.id, message);
          if (lostSend) { lostSend = false; throw new Error('send response lost'); }
          return message;
        } };
      channels.set(channel.id, channel); return channel;
    } },
  } as unknown as Guild;
  return { db, input, guild, creates, roles, channels, permissions, messages, loseSend: () => { lostSend = true; } };
}

test('inhouse provisioning previews without writes and recovers a lost opt-in send without duplicate resources', async () => {
  const f = fixture();
  try {
    const preview = await setupInhouses(f.guild, f.db, f.input);
    assert.equal(getInhouseConfig(f.db, 'guild'), undefined);
    assert.equal(f.creates.length, 0);
    f.loseSend();
    await assert.rejects(setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: preview.fingerprint }), /response lost/);
    assert.equal(f.creates.length, 3);
    assert.equal(getInhouseConfig(f.db, 'guild')?.messageId, null);
    const recovery = await setupInhouses(f.guild, f.db, f.input);
    const applied = await setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: recovery.fingerprint });
    assert.ok('messageId' in applied);
    assert.equal(applied.messageId, 'optin');
    assert.equal(f.creates.length, 3);
    assert.equal(f.messages.get('optin').pinned, true);
    assert.equal(f.creates[0].permissions, 0n);
    assert.deepEqual(f.creates[1].permissionOverwrites.map((entry: any) => entry.deny), [PermissionsBitField.Flags.ViewChannel]);
    assert.deepEqual(f.creates[2].allowedMentions, { parse: [], roles: [], users: [] });
    const repeat = await setupInhouses(f.guild, f.db, f.input);
    await setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: repeat.fingerprint });
    assert.equal(f.creates.length, 3);
  } finally { f.db.close(); }
});

test('inhouse setup refuses unowned resources and revoked category permissions before writes', async () => {
  const f = fixture();
  try {
    f.roles.set('foreign', { id: 'foreign', name: 'Inhouse', editable: true, managed: false,
      permissions: new PermissionsBitField(0n) });
    await assert.rejects(setupInhouses(f.guild, f.db, f.input), /unowned role/);
    f.roles.clear();
    const preview = await setupInhouses(f.guild, f.db, f.input);
    f.permissions.remove(PermissionsBitField.Flags.SendMessages);
    f.permissions.remove(PermissionsBitField.Flags.Administrator);
    await assert.rejects(setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: preview.fingerprint }), /inherited category/);
    assert.deepEqual(f.creates, []);
    assert.equal(getInhouseConfig(f.db, 'guild'), undefined);
  } finally { f.db.close(); }
});

test('equivalent permission overwrite order keeps a reviewed setup plan valid', async () => {
  const f = fixture();
  try {
    const category = f.channels.get('permanent');
    const overwrites = category.permissionOverwrites.cache;
    const bot = { id: 'rat', type: 0, allow: new PermissionsBitField(PermissionsBitField.Flags.SendMessages),
      deny: new PermissionsBitField(0n) };
    overwrites.set(bot.id, bot);
    const preview = await setupInhouses(f.guild, f.db, f.input);
    const everyone = overwrites.get('everyone');
    overwrites.delete('everyone'); overwrites.set('everyone', everyone);
    const reordered = await setupInhouses(f.guild, f.db, f.input);
    assert.equal(reordered.fingerprint, preview.fingerprint);
    await setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: preview.fingerprint });
    assert.equal(getInhouseConfig(f.db, 'guild')?.messageId, 'optin');
    const boundPlan = await setupInhouses(f.guild, f.db, f.input);
    everyone.deny = new PermissionsBitField(0n);
    await assert.rejects(setupInhouses(f.guild, f.db, f.input, { write: true, expectedPlan: boundPlan.fingerprint }), /fingerprint/);
  } finally { f.db.close(); }
});
