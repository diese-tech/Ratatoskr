import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Collection, type Client, type Guild } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { installGuildRoleInventory } from './guildRoleInventory.js';
import { getGuildRoleInventory } from '../db/repositories/guildRoleInventory.js';
import { readLeagueMembers } from './leagueMemberReads.js';

function fixture() {
  const db = openDatabase(':memory:');
  const events = new EventEmitter();
  const client = events as unknown as Client;
  const roles = new Collection<string, any>([['inhouse', { id: 'inhouse', name: 'Inhouse' }]]);
  const members = new Collection<string, any>();
  let fetches = 0;
  const guild: any = { id: 'guild', client, shardId: 0, available: true, memberCount: 0,
    roles: { cache: roles }, members: { cache: members, fetch: async () => { fetches++; return members; } } };
  const member = (id: string, roleIds: string[], bot = false) => ({ id, guild, partial: false,
    displayName: id, nickname: null, user: { id, bot }, roles: { cache: new Collection(roleIds.map(role => [role, roles.get(role)])) } });
  const stop = installGuildRoleInventory(client, db, 'guild');
  return { db, client, events, guild: guild as Guild, members, roles, member, stop, fetches: () => fetches };
}

test('shared server inventory records role events and a complete existing member read without extra requests', async () => {
  const f = fixture();
  try {
    const player = f.member('player', []);
    const bot = f.member('bot', ['inhouse'], true);
    f.members.set(player.id, player); f.members.set(bot.id, bot);
    (f.guild as any).memberCount = 2;
    await readLeagueMembers(f.guild);
    const full = getGuildRoleInventory(f.db, 'guild');
    assert.equal(f.fetches(), 1);
    assert.equal(full.members.length, 2);
    assert.ok(full.lastFullAt);
    assert.deepEqual(full.roles.map(role => role.name), ['Inhouse']);
    player.roles.cache.set('inhouse', f.roles.get('inhouse'));
    f.events.emit('guildMemberUpdate', player, player);
    assert.deepEqual(getGuildRoleInventory(f.db, 'guild').members.find(m => m.discordId === 'player')?.roleIds, ['inhouse']);
    f.events.emit('guildMemberRemove', { id: player.id, guild: f.guild });
    assert.equal(getGuildRoleInventory(f.db, 'guild').members.find(m => m.discordId === 'player')?.present, false);
    f.events.emit('guildMemberAdd', player);
    assert.equal(getGuildRoleInventory(f.db, 'guild').members.find(m => m.discordId === 'player')?.present, true);
    f.events.emit('roleDelete', { id: 'inhouse', guild: f.guild });
    assert.ok(getGuildRoleInventory(f.db, 'guild').members.every(m => !m.roleIds.includes('inhouse')));
    assert.equal(f.fetches(), 1, 'Member/role events do not call Discord or Sheets.');
  } finally { f.stop(); f.db.close(); }
});

test('incomplete member reads preserve inventory and a complete catch-up records offline departure', async () => {
  const f = fixture();
  try {
    const a = f.member('a', ['inhouse']), b = f.member('b', []);
    f.members.set(a.id, a); f.members.set(b.id, b); (f.guild as any).memberCount = 2;
    await readLeagueMembers(f.guild);
    const before = getGuildRoleInventory(f.db, 'guild');
    f.members.delete('a');
    await assert.rejects(readLeagueMembers(f.guild), /incomplete/);
    assert.deepEqual(getGuildRoleInventory(f.db, 'guild'), before);
    (f.guild as any).memberCount = 1;
    await readLeagueMembers(f.guild);
    assert.equal(getGuildRoleInventory(f.db, 'guild').members.find(m => m.discordId === 'a')?.present, false);
    const foreign = { ...b, guild: { id: 'other' }, displayName: 'wrong server' };
    f.events.emit('guildMemberUpdate', foreign, foreign);
    assert.equal(getGuildRoleInventory(f.db, 'guild').members.find(m => m.discordId === 'b')?.displayName, 'b');
    assert.deepEqual(getGuildRoleInventory(f.db, 'other').members, []);
  } finally { f.stop(); f.db.close(); }
});

test('inventory write failures cannot abort league member reads or leave a partial full snapshot', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  try {
    const player = f.member('player', []);
    f.members.set(player.id, player); (f.guild as any).memberCount = 1;
    f.db.exec("CREATE TRIGGER reject_inventory BEFORE INSERT ON guild_inventory_roles BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    assert.equal((await readLeagueMembers(f.guild)).length, 1);
    assert.deepEqual(getGuildRoleInventory(f.db, 'guild').members, []);
    assert.equal(getGuildRoleInventory(f.db, 'guild').lastFullAt, null);
    f.db.exec('DROP TRIGGER reject_inventory');
    await readLeagueMembers(f.guild);
    assert.equal(getGuildRoleInventory(f.db, 'guild').members.length, 1);
  } finally { f.stop(); f.db.close(); }
});
