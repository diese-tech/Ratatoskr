import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, type Guild } from 'discord.js';
import { formatScoutSlotLabel, resolveScoutPlayerNames } from './scoutPlayerNames.js';

test('player labels use guild display name, global name, username, then abbreviated fallback', async () => {
  const members = new Collection<string, any>([
    ['cached', { displayName: 'Guild nickname', user: { globalName: 'Global', username: 'handle' } }],
  ]);
  const users = new Collection<string, any>([['global', { globalName: 'Global Name', username: 'handle' }]]);
  let memberFetches = 0;
  const guild = { members: { cache: members, fetch: async (id: string) => {
    memberFetches++;
    if (id === 'uncached') return { displayName: 'Fetched nickname' };
    throw new Error('Unknown member');
  } }, client: { users: { cache: users, fetch: async (id: string) => {
    if (id === 'username') return { globalName: null, username: 'Discord handle' };
    throw new Error('Unknown user');
  } } } } as unknown as Guild;
  const names = await resolveScoutPlayerNames(guild, ['cached', 'cached', 'uncached', 'global', 'username', '456631467955716097']);
  assert.equal(names.get('cached'), 'Guild nickname');
  assert.equal(names.get('uncached'), 'Fetched nickname');
  assert.equal(names.get('global'), 'Global Name');
  assert.equal(names.get('username'), 'Discord handle');
  assert.equal(names.get('456631467955716097'), 'Unknown Player (…6097)');
  assert.equal(memberFetches, 4, 'cached/duplicate names must not trigger repeated lookups');
});

test('long and duplicate names preserve readable game/team/role labels', async () => {
  const guild = { members: { cache: new Collection(), fetch: async () => ({ displayName: `\n${'Long player name '.repeat(8)}` }) } } as unknown as Guild;
  const names = await resolveScoutPlayerNames(guild, ['one', 'two']);
  const slot = { gameNumber: 2, team: 'team_two' as const, role: 'carry' as const, userId: 'one' };
  const label = formatScoutSlotLabel(slot, names.get('one'));
  assert.match(label, /^G2 • Chaos • Carry — Long player/);
  assert.ok(label.length < 80);
  assert.ok(!label.includes('\n'));
  assert.notEqual(names.get('one'), names.get('two'), 'colliding candidates must also be visibly distinguishable');
});

test('colliding display names retain a distinguishable account suffix, including truncated names', async () => {
  const guild = { members: { cache: new Collection(), fetch: async (id: string) => ({
    displayName: 'Same player nickname '.repeat(5),
    user: { username: id === '11115678' ? 'first_account' : 'second_account' },
  }) } } as unknown as Guild;
  const names = await resolveScoutPlayerNames(guild, ['11115678', '22225678']);
  assert.match(names.get('11115678')!, /@first_account/);
  assert.match(names.get('22225678')!, /@second_account/);
  for (const [userId, name] of names) assert.ok(formatScoutSlotLabel({ gameNumber: 2, team: 'team_two', role: 'support', userId }, name).length <= 100);
});
