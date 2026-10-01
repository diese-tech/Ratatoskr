import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, type Guild } from 'discord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';

test('transaction announcements enforce the durable reference as the Discord nonce', async () => {
  const sent: Record<string, unknown>[] = [];
  const guild = { id: 'guild' } as unknown as Guild;
  const channel = {
    type: ChannelType.GuildText,
    guild,
    send: async (payload: Record<string, unknown>) => { sent.push(payload); return { id: 'message' }; },
  };
  Object.assign(guild, { channels: { fetch: async () => channel } });
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const reference = 'YSL-TRX-20260930-ABC12345';
  await gateway.announce({
    content: '<@&team-a>',
    allowedRoleIds: ['team-a'],
    title: 'Word Travels the Branches',
    description: 'A move happened.',
    footer: 'Posted by Admin',
  }, reference);
  assert.equal(sent[0]?.nonce, reference);
  assert.equal(sent[0]?.enforceNonce, true);
});

test('a forced member fetch rejects unrelated league-role drift before applying a change', async () => {
  let mutations = 0;
  const cache = new Collection<string, unknown>([
    ['team-a', {}],
    ['team-b', {}],
    ['division-v', {}],
  ]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async () => { mutations += 1; },
      add: async () => { mutations += 1; },
    },
  };
  const guild = {
    id: 'guild',
    members: { fetch: async () => member },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const before = {
    configuredTeamRoleIds: ['team-a', 'team-b', 'team-c'],
    expectedTeamRoleId: 'team-a',
    configuredDivisionRoleIds: ['division-v'],
    freeAgentRoleId: 'free-agent',
    expectsFreeAgent: false,
    divisionRoleId: 'division-v',
  };
  await assert.rejects(() => gateway.applyRoleChange(
    { discordId: 'one', remove: ['team-a'], add: ['team-c'] },
    before,
    { ...before, expectedTeamRoleId: 'team-c' },
  ), /complete league role state changed/i);
  assert.equal(mutations, 0);
});

test('a forced member fetch rejects an additional configured division role', async () => {
  let mutations = 0;
  const cache = new Collection<string, unknown>([
    ['team-a', {}],
    ['division-v', {}],
    ['division-a', {}],
  ]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async () => { mutations += 1; },
      add: async () => { mutations += 1; },
    },
  };
  const guild = {
    id: 'guild',
    members: { fetch: async () => member },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const before = {
    configuredTeamRoleIds: ['team-a', 'team-b'],
    expectedTeamRoleId: 'team-a',
    configuredDivisionRoleIds: ['division-v', 'division-a'],
    freeAgentRoleId: 'free-agent',
    expectsFreeAgent: false,
    divisionRoleId: 'division-v',
  };
  await assert.rejects(() => gateway.applyRoleChange(
    { discordId: 'one', remove: ['team-a'], add: ['team-b'] },
    before,
    { ...before, expectedTeamRoleId: 'team-b' },
  ), /complete league role state changed/i);
  assert.equal(mutations, 0);
});

test('post-change verification requires the complete destination role state', async () => {
  const cache = new Collection<string, unknown>([
    ['team-a', {}],
    ['division-v', {}],
  ]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async (roleIds: string[]) => { for (const roleId of roleIds) cache.delete(roleId); },
      add: async (roleIds: string[]) => {
        for (const roleId of roleIds) cache.set(roleId, {});
        if (roleIds.includes('team-c')) cache.set('team-b', {});
      },
    },
  };
  const guild = {
    id: 'guild',
    members: { fetch: async () => member },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const before = {
    configuredTeamRoleIds: ['team-a', 'team-b', 'team-c'],
    expectedTeamRoleId: 'team-a',
    configuredDivisionRoleIds: ['division-v'],
    freeAgentRoleId: 'free-agent',
    expectsFreeAgent: false,
    divisionRoleId: 'division-v',
  };
  await assert.rejects(() => gateway.applyRoleChange(
    { discordId: 'one', remove: ['team-a'], add: ['team-c'] },
    before,
    { ...before, expectedTeamRoleId: 'team-c' },
  ), (error: Error & { reconciliationRequired?: boolean }) => error.reconciliationRequired === true);
});
