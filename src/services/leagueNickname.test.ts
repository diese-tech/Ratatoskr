import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionsBitField, PermissionFlagsBits, type Guild } from 'discord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';

function fixture() {
  let nickname: string | null = null;
  let manageable = true;
  let lostResponse = false;
  let writes = 0;
  const permissions = new PermissionsBitField(PermissionFlagsBits.ManageNicknames);
  const member = { id: 'one', user: { bot: false }, get nickname() { return nickname; }, get displayName() { return nickname ?? 'One'; },
    get manageable() { return manageable; }, setNickname: async (value: string | null) => { nickname = value; writes++; if (lostResponse) throw Error('Response lost'); } };
  const guild = { roles: { fetch: async () => {} }, members: { fetchMe: async () => ({ permissions }), fetch: async (options: unknown) => {
    assert.deepEqual(options, { user: 'one', force: true }); return member;
  } } } as unknown as Guild;
  const change = { discordId: 'one', before: null, beforeDisplayName: 'One', after: 'One Prime' };
  return { gateway: new DiscordLeagueGateway(guild, 'notices'), change, permissions, member,
    get writes() { return writes; }, setNickname: (value: string | null) => { nickname = value; }, unmanageable: () => { manageable = false; }, loseResponse: () => { lostResponse = true; } };
}

test('nickname writes force-check permission, hierarchy and exact before state', async () => {
  const f = fixture();
  f.permissions.remove(PermissionFlagsBits.ManageNicknames);
  await assert.rejects(() => f.gateway.applyNicknameChange(f.change), /Manage Nicknames/);
  f.permissions.add(PermissionFlagsBits.ManageNicknames);
  f.setNickname('Changed by staff');
  await assert.rejects(() => f.gateway.applyNicknameChange(f.change), /fresh rename preview/);
  f.setNickname(null); f.unmanageable();
  await assert.rejects(() => f.gateway.applyNicknameChange(f.change), /hierarchy/);
  assert.equal(f.writes, 0);
});

test('a nickname rename verifies its result and safely restores an original null nickname', async () => {
  const f = fixture();
  await f.gateway.applyNicknameChange(f.change);
  assert.equal(f.member.displayName, 'One Prime');
  await f.gateway.rollbackNicknameChange(f.change);
  assert.equal(f.member.nickname, null);
  assert.equal(f.member.displayName, 'One');
  assert.equal(f.writes, 2);
});

test('ambiguous nickname responses require reconciliation and rollback cannot overwrite later staff edits', async () => {
  const f = fixture(); f.loseResponse();
  await assert.rejects(() => f.gateway.applyNicknameChange(f.change), error => !!error && typeof error === 'object' && 'reconciliationRequired' in error);
  assert.equal(f.member.nickname, 'One Prime');
  f.setNickname('Later staff edit');
  await assert.rejects(() => f.gateway.rollbackNicknameChange(f.change), /fresh rename preview/);
  assert.equal(f.member.nickname, 'Later staff edit');
  assert.equal(f.writes, 1);
});

test('syncing an already-set nickname performs no Discord mutation and requires no extra nickname permission', async () => {
  const f = fixture(); f.permissions.remove(PermissionFlagsBits.ManageNicknames); f.unmanageable(); f.setNickname('One Prime');
  await f.gateway.applyNicknameChange({ ...f.change, before: 'One Prime', beforeDisplayName: 'One Prime' });
  assert.equal(f.writes, 0);
});
