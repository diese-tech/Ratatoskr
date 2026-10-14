import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, createScoutSetup, getScoutSetupById, listDivisions,
  listDivisionScoutLifecycleBlockers } from '../db/index.js';
import { beginInhouseConfiguration, bindInhouseResource, setInhouseSubscription } from '../db/repositories/inhouse.js';
import { handleInhouseRoleReaction, reconcileInhouseRoles, retryInhouseRoles } from './inhouseRoles.js';
import { Collection, type Client, type Guild, type MessageReaction, type User } from 'discord.js';
import { canManageScoutSetup } from './scoutAuthorization.js';

test('an open inhouse persists independently without creating a league division', () => {
  const db = openDatabase(':memory:');
  try {
    const setup = createScoutSetup(db, {
      workflow: 'inhouse', guildId: 'guild', divisionId: null, divisionKey: 'inhouse',
      divisionDisplayName: 'Inhouse', createdBy: 'host', signupChannelId: 'inhouses',
      resultsChannelId: 'inhouses', operationsChannelId: 'inhouses', divisionRoleId: 'inhouse-role',
      eligibilityRoleId: null, emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c', fill: null },
      startAt: 2_000_000_000, roleLimit: 2,
    });
    assert.equal(getScoutSetupById(db, setup.id)?.workflow, 'inhouse');
    assert.equal(getScoutSetupById(db, setup.id)?.divisionId, null);
    assert.deepEqual(listDivisions(db, 'guild'), []);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild', 1), []);
  } finally { db.close(); }
});

test('only the creator with the current Inhouse role can manage an inhouse', async () => {
  const db = openDatabase(':memory:');
  try {
    beginInhouseConfiguration(db, { guildId: 'guild', categoryId: 'permanent', roleName: 'Inhouse', channelName: 'inhouses', emoji: '🎮' });
    bindInhouseResource(db, 'guild', 'roleId', 'optin-role');
    bindInhouseResource(db, 'guild', 'channelId', 'inhouses');
    const setup = createScoutSetup(db, { workflow: 'inhouse', guildId: 'guild', divisionId: null,
      divisionKey: 'inhouse', divisionDisplayName: 'Inhouse', createdBy: 'host', signupChannelId: 'inhouses',
      resultsChannelId: 'inhouses', operationsChannelId: 'inhouses', divisionRoleId: 'optin-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c', fill: null },
      startAt: 2_000_000_000, roleLimit: 2 });
    let rolePresent = true;
    const guild = { id: 'guild', members: { fetch: async () => ({ user: { bot: false },
      roles: { cache: { has: (id: string) => rolePresent && id === 'optin-role' } } }) } } as unknown as Guild;
    assert.equal(await canManageScoutSetup(db, guild, 'host', setup), true);
    assert.equal(await canManageScoutSetup(db, guild, 'other-host', setup), false);
    rolePresent = false;
    assert.equal(await canManageScoutSetup(db, guild, 'host', setup), false);
  } finally { db.close(); }
});

function roleFixture() {
  const db = openDatabase(':memory:');
    beginInhouseConfiguration(db, { guildId: 'guild', categoryId: 'permanent', roleName: 'Inhouse', channelName: 'inhouses', emoji: '🎮' });
    bindInhouseResource(db, 'guild', 'roleId', 'optin-role');
    bindInhouseResource(db, 'guild', 'channelId', 'inhouses');
    bindInhouseResource(db, 'guild', 'messageId', 'optin-message');
    const roles = new Set<string>(['league-player']);
    const member = { user: { bot: false }, roles: { cache: { has: (id: string) => roles.has(id) },
      add: async (id: string) => { roles.add(id); }, remove: async (id: string) => { roles.delete(id); } } };
    const role = { id: 'optin-role', managed: false, editable: true, permissions: { bitfield: 0n } };
    const guild = { id: 'guild', roles: { fetch: async () => role }, members: { fetch: async () => member } };
    const observed = new Collection<string, User>();
    const message = { id: 'optin-message', guildId: 'guild', channelId: 'inhouses', partial: false,
      author: { id: 'rat' }, react: async () => {}, reactions: { cache: new Map([
        ['🎮', { users: { fetch: async () => observed } }],
      ]) } };
    const client = { user: { id: 'rat' }, guilds: { fetch: async () => guild }, channels: { fetch: async () => ({
      guildId: 'guild', isTextBased: () => true, messages: { fetch: async () => message },
    }) } } as unknown as Client;
    const reaction = { emoji: { id: null, name: '🎮' }, message: { id: 'optin-message', guildId: 'guild',
      channelId: 'inhouses', partial: false, author: { id: 'rat' } } } as unknown as MessageReaction;
    const user = { id: 'player', bot: false } as User;
    return { db, client, reaction, user, roles, role, member, observed };
}

test('the canonical opt-in reaction adds only the Inhouse role and removing it removes that role', async () => {
  const f = roleFixture();
  try {
    assert.equal(await handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, true), true);
    assert.deepEqual([...f.roles].sort(), ['league-player', 'optin-role']);
    assert.equal(await handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, false), true);
    assert.deepEqual([...f.roles], ['league-player']);
  } finally { f.db.close(); }
});

test('offline opt-outs reconcile without removing unrelated roles or fetching server-wide members', async () => {
  const f = roleFixture();
  try {
    await handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, true);
    await reconcileInhouseRoles(f.client, f.db, 'guild', async error => { throw error; });
    assert.deepEqual([...f.roles], ['league-player']);
    f.observed.set(f.user.id, f.user);
    await reconcileInhouseRoles(f.client, f.db, 'guild', async error => { throw error; });
    assert.deepEqual([...f.roles].sort(), ['league-player', 'optin-role']);
  } finally { f.db.close(); }
});

test('failed role writes remain pending and recover once without replaying an old opt-in', async t => {
  const f = roleFixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const add = f.member.roles.add;
  f.member.roles.add = async () => { throw new Error('Discord unavailable'); };
  try {
    await assert.rejects(handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, true), /unavailable/);
    assert.deepEqual([...f.roles], ['league-player']);
    f.member.roles.add = add;
    now += 60_001;
    await retryInhouseRoles(f.client, f.db, 'guild', async error => { throw error; });
    assert.deepEqual([...f.roles].sort(), ['league-player', 'optin-role']);
    const optIn = handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, true);
    const optOut = handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, false);
    await Promise.all([optIn, optOut]);
    assert.deepEqual([...f.roles], ['league-player']);
  } finally { f.db.close(); }
});

test('unrelated reactions and privileged role drift cannot grant the opt-in role', async () => {
  const f = roleFixture();
  try {
    const unrelated = { ...f.reaction, message: { ...f.reaction.message, id: 'other' } } as MessageReaction;
    assert.equal(await handleInhouseRoleReaction(f.client, f.db, unrelated, f.user, true), false);
    f.role.permissions.bitfield = 8n;
    await assert.rejects(handleInhouseRoleReaction(f.client, f.db, f.reaction, f.user, true), /privileged/);
    assert.deepEqual([...f.roles], ['league-player']);
  } finally { f.db.close(); }
});

test('a persistently failing member cannot starve other pending inhouse role changes', async t => {
  const f = roleFixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const visited: string[] = [];
  const guild = await f.client.guilds.fetch('guild');
  t.mock.method(guild.members, 'fetch', async ({ user }: { user: string }) => {
    visited.push(user);
    if (user === 'a-failing') throw { code: 50013 };
    return f.member;
  });
  try {
    setInhouseSubscription(f.db, 'guild', 'a-failing', true);
    setInhouseSubscription(f.db, 'guild', 'player', true);
    await retryInhouseRoles(f.client, f.db, 'guild', async () => {});
    now += 60_001;
    await retryInhouseRoles(f.client, f.db, 'guild', async () => {});
    assert.ok(visited.includes('player'));
    assert.ok(f.roles.has('optin-role'));
  } finally { f.db.close(); }
});
