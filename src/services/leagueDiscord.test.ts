import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';

function leagueMember(id: string, roleIds: string[]) {
  return {
    id,
    displayName: `Player ${id}`,
    user: { bot: false },
    roles: { cache: new Collection(roleIds.map((roleId) => [roleId, {}])) },
  };
}

test('repeated roster reads reuse the complete live Discord cache instead of requesting every member again', async () => {
  const member = leagueMember('one', ['team-a']);
  const cache = new Collection<string, any>([['one', member]]);
  let fetches = 0;
  const guild = {
    id: 'guild',
    members: { cache, fetch: async () => { fetches += 1; return cache; } },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');

  assert.deepEqual((await gateway.getMembers())[0]?.roleIds, ['team-a']);
  member.roles.cache.set('division-v', {});
  assert.deepEqual((await gateway.getMembers())[0]?.roleIds.sort(), ['division-v', 'team-a']);
  assert.equal(fetches, 1);
});

test('display-name validation force-fetches the member instead of trusting the complete-member cache', async () => {
  const cached = leagueMember('one', ['team-a']);
  const current = { ...leagueMember('one', ['team-a']), displayName: 'Newer Name' };
  const cache = new Collection<string, any>([['one', cached]]);
  const fetchArguments: unknown[] = [];
  const guild = {
    id: 'guild',
    members: {
      cache,
      fetch: async (options?: unknown) => {
        fetchArguments.push(options);
        if (options && typeof options === 'object' && 'force' in options) return current;
        return cache;
      },
    },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');

  await gateway.getMembers();
  await assert.rejects(() => gateway.validateDisplayName('one', 'Player one'), /display name changed/i);
  assert.deepEqual(fetchArguments[1], { user: 'one', force: true });
});

test('a Discord full-member rate limit falls back to a previously complete live cache', async () => {
  const member = leagueMember('one', ['team-a']);
  const cache = new Collection<string, any>([['one', member]]);
  let now = 0;
  let fetches = 0;
  const guild = {
    id: 'guild',
    members: {
      cache,
      fetch: async () => {
        fetches += 1;
        if (fetches === 1) return cache;
        throw Object.assign(new Error('Request with opcode 8 was rate limited.'), {
          data: { opcode: 8, retry_after: 27.819 },
        });
      },
    },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions', { now: () => now });

  await gateway.getMembers();
  now = 60_001;
  member.roles.cache.set('division-v', {});
  const fallback = await gateway.getMembers();

  assert.deepEqual(fallback[0]?.roleIds.sort(), ['division-v', 'team-a']);
  assert.equal(fetches, 2);
});

test('a first full-member rate limit waits for Discord and retries once', async () => {
  const member = leagueMember('one', ['team-a']);
  const cache = new Collection<string, any>([['one', member]]);
  let fetches = 0;
  const waits: number[] = [];
  const guild = {
    id: 'guild',
    members: {
      cache,
      fetch: async () => {
        fetches += 1;
        if (fetches === 1) {
          throw Object.assign(new Error('Request with opcode 8 was rate limited.'), {
            data: { opcode: 8, retry_after: 0.01 },
          });
        }
        return cache;
      },
    },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions', {
    sleep: async (delayMs) => { waits.push(delayMs); },
  });

  assert.equal((await gateway.getMembers()).length, 1);
  assert.equal(fetches, 2);
  assert.deepEqual(waits, [260]);
});

test('departure absence validation accepts only Discord-confirmed unknown members', async () => {
  const guild = {
    id: 'guild',
    members: { fetch: async () => { throw Object.assign(new Error('Unknown Member'), { code: RESTJSONErrorCodes.UnknownMember }); } },
  } as unknown as Guild;
  await new DiscordLeagueGateway(guild, 'transactions').validateMemberAbsent('departed');
});

test('departure absence validation rejects a member who is currently present', async () => {
  const guild = {
    id: 'guild',
    members: { fetch: async () => ({ id: 'returned' }) },
  } as unknown as Guild;
  await assert.rejects(
    () => new DiscordLeagueGateway(guild, 'transactions').validateMemberAbsent('returned'),
    /back in the YSL server.*transaction drop/i,
  );
});

test('self-drop absence validation preserves the self-drop remedy if the player returned', async () => {
  const guild = {
    id: 'guild',
    members: { fetch: async () => ({ id: 'returned' }) },
  } as unknown as Guild;
  await assert.rejects(
    () => new DiscordLeagueGateway(guild, 'transactions').validateMemberAbsent('returned', 'self-drop'),
    /back in the YSL server.*transaction self-drop/i,
  );
});

test('departure absence validation does not mistake a transient Discord failure for departure', async () => {
  const guild = {
    id: 'guild',
    members: { fetch: async () => { throw new Error('gateway unavailable'); } },
  } as unknown as Guild;
  await assert.rejects(
    () => new DiscordLeagueGateway(guild, 'transactions').validateMemberAbsent('unknown'),
    /could not confirm.*left the YSL server/i,
  );
});

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

test('announcement recovery finds an old matching nonce before sending again', async () => {
  const reference = 'YSL-TRX-20260930-RECOVER';
  let fetches = 0;
  const oldMessages = new Collection<string, any>();
  for (let index = 0; index < 100; index += 1) {
    oldMessages.set(`new-${index}`, { id: `new-${index}`, nonce: null, author: { id: 'rat' } });
  }
  const matched = { id: 'existing-message', nonce: reference, author: { id: 'rat' } };
  const channel = {
    type: ChannelType.GuildText,
    guild: { id: 'guild' },
    messages: { fetch: async () => (++fetches === 1 ? oldMessages : new Collection([[matched.id, matched]])) },
  };
  const guild = {
    id: 'guild',
    client: { user: { id: 'rat' } },
    channels: { fetch: async () => channel },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  assert.equal(await gateway.findAnnouncement(reference), 'existing-message');
  assert.equal(fetches, 2);
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
  ), (error: Error & { reconciliationRequired?: boolean }) => error.reconciliationRequired === true
    && /complete league role state changed/i.test(error.message));
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

test('audit repair can reconcile a known-invalid managed role set to the approved sheet assignment', async () => {
  const cache = new Collection<string, unknown>([
    ['team-b', {}],
    ['division-a', {}],
    ['free-agent', {}],
  ]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async (roleIds: string[]) => { for (const roleId of roleIds) cache.delete(roleId); },
      add: async (roleIds: string[]) => { for (const roleId of roleIds) cache.set(roleId, {}); },
    },
  };
  const guild = { id: 'guild', members: { fetch: async () => member } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const expected = {
    configuredTeamRoleIds: ['team-a', 'team-b'], expectedTeamRoleId: 'team-a',
    configuredDivisionRoleIds: ['division-v', 'division-a'], divisionRoleId: 'division-v',
    freeAgentRoleId: 'free-agent', expectsFreeAgent: false,
  };

  await gateway.reconcileManagedRoles(
    { discordId: 'one', remove: ['team-b', 'division-a', 'free-agent'], add: ['team-a', 'division-v'] },
    expected,
    ['team-b', 'division-a', 'free-agent'],
  );

  assert.deepEqual([...cache.keys()].sort(), ['division-v', 'team-a']);
});

test('audit repair refuses a managed-role change made after the audit snapshot', async () => {
  let mutations = 0;
  const cache = new Collection<string, unknown>([['team-c', {}], ['division-v', {}]]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async () => { mutations += 1; },
      add: async () => { mutations += 1; },
    },
  };
  const guild = { id: 'guild', members: { fetch: async () => member } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const expected = {
    configuredTeamRoleIds: ['team-a', 'team-b', 'team-c'], expectedTeamRoleId: 'team-a',
    configuredDivisionRoleIds: ['division-v'], divisionRoleId: 'division-v',
    freeAgentRoleId: 'free-agent', expectsFreeAgent: false,
  };

  await assert.rejects(() => gateway.reconcileManagedRoles(
    { discordId: 'one', remove: ['team-b'], add: ['team-a'] },
    expected,
    ['team-b', 'division-v'],
  ), /changed after the audit was loaded.*no roles were changed/i);
  assert.equal(mutations, 0);
});

test('post-change verification requires the complete destination role state', async () => {
  let mutations = 0;
  const cache = new Collection<string, unknown>([
    ['team-a', {}],
    ['division-v', {}],
  ]);
  const member = {
    id: 'one',
    roles: {
      cache,
      remove: async (roleIds: string[]) => { mutations += 1; for (const roleId of roleIds) cache.delete(roleId); },
      add: async (roleIds: string[]) => {
        mutations += 1;
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
  assert.equal(mutations, 2);
  assert.equal(cache.has('team-a'), false);
  assert.equal(cache.has('team-b'), true);
  assert.equal(cache.has('team-c'), true);
});

test('rollback preserves a newer manual role change and requires reconciliation', async () => {
  let mutations = 0;
  const cache = new Collection<string, unknown>([
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
  await assert.rejects(() => gateway.rollbackRoleChange(
    { discordId: 'one', remove: ['team-a'], add: ['team-c'] },
    before,
    { ...before, expectedTeamRoleId: 'team-c' },
  ), (error: Error & { reconciliationRequired?: boolean }) => error.reconciliationRequired === true);
  assert.equal(mutations, 0);
  assert.equal(cache.has('team-b'), true);
});
