import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, Client, Collection, PermissionFlagsBits, PermissionsBitField, RESTJSONErrorCodes, type ClientUser, type Guild, type GuildMember } from 'discord.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import { leagueMemberReadDiagnostics } from './leagueMemberReads.js';

function leagueMember(id: string, roleIds: string[]) {
  return {
    id,
    displayName: `Player ${id}`,
    user: { bot: false },
    roles: { cache: new Collection(roleIds.map((roleId) => [roleId, {}])) },
  };
}

test('distinct gateway instances share an equivalent in-flight full guild request', async () => {
  const cache = new Collection([['one', leagueMember('one', ['team-a'])]]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  const guild = { id: 'guild', members: { cache, fetch: async () => {
    fetches += 1; await held; return cache;
  } } } as unknown as Guild;
  const first = new DiscordLeagueGateway(guild, 'transactions').getMembers();
  const second = new DiscordLeagueGateway(guild, 'transactions').getMembers();
  const replacement = new DiscordLeagueGateway(guild, 'transactions').getAccountReplacementMembers();
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await replacement)[0]?.guildId, 'guild');
  assert.equal(fetches, 1);
  assert.equal(leagueMemberReadDiagnostics(guild).coalesced, 2);
});

test('cancelling one consumer leaves another shared full request intact', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  const guild = { id: 'guild', members: { fetch: async () => {
    fetches += 1; await held; return new Collection([['one', leagueMember('one', [])]]);
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  const first = gateway.getMembers({ signal: controller.signal });
  const second = new DiscordLeagueGateway(guild, 'transactions').getMembers();
  controller.abort(Error('operator cancelled'));
  await assert.rejects(() => first, /operator cancelled/);
  release();
  assert.equal((await second).length, 1);
  assert.equal(fetches, 1);
});

test('concurrent short-cooldown consumers share recovery even when their wait completions are staggered', async () => {
  let now = 0;
  let fetches = 0;
  let firstWait!: () => void;
  let secondWait!: () => void;
  const firstGate = new Promise<void>((resolve) => { firstWait = resolve; });
  const secondGate = new Promise<void>((resolve) => { secondWait = resolve; });
  let bothWaiting!: () => void;
  const began = new Promise<void>((resolve) => { bothWaiting = resolve; });
  let waits = 0;
  const clock = { now: () => now, sleep: async () => {
    waits += 1;
    if (waits === 1) await firstGate;
    else { bothWaiting(); await secondGate; }
  } };
  const guild = { id: 'guild', members: { fetch: async () => {
    fetches += 1;
    if (fetches === 1) throw Object.assign(Error('limited'), { data: { opcode: 8, retry_after: 0.01 } });
    return new Collection([['one', leagueMember('one', [])]]);
  } } } as unknown as Guild;
  const first = new DiscordLeagueGateway(guild, 'transactions', clock).getMembers();
  const second = new DiscordLeagueGateway(guild, 'transactions', clock).getMembers();
  await began;
  now = 260;
  firstWait();
  await first;
  secondWait();
  await second;
  assert.equal(fetches, 2);
});

test('cancelling a short throttle wait prevents retry and retains the shared cooldown', async () => {
  const controller = new AbortController();
  let waited!: () => void;
  const beganWait = new Promise<void>((resolve) => { waited = resolve; });
  let finishWait!: () => void;
  const held = new Promise<void>((resolve) => { finishWait = resolve; });
  let now = 0;
  let fetches = 0;
  const guild = { id: 'guild', members: { fetch: async () => {
    fetches += 1;
    if (fetches === 1) throw Object.assign(Error('limited'), { data: { opcode: 8, retry_after: 0.01 } });
    return new Collection([['one', leagueMember('one', [])]]);
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions', { now: () => now,
    sleep: async () => { waited(); await held; } });
  const read = gateway.getMembers({ signal: controller.signal });
  await beganWait;
  controller.abort(Error('cancel wait'));
  await assert.rejects(() => read, /cancel wait/);
  await assert.rejects(() => new DiscordLeagueGateway(guild, 'transactions', { now: () => now })
    .getMembers({ observation: true }), /cooldown/);
  assert.equal(fetches, 1);
  now = 261;
  finishWait();
  assert.equal((await gateway.getMembers()).length, 1);
  assert.equal(fetches, 2);
});

test('incomplete collections and member changes during a full fetch cannot become absence or mutation proof', async () => {
  const client = new EventEmitter();
  let changed = false;
  const member = leagueMember('one', []);
  const guild = { id: 'guild', client, memberCount: 2, members: { fetch: async () => {
    if (changed) client.emit('guildMemberRemove', { guild });
    return new Collection([['one', member]]);
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  await assert.rejects(() => gateway.getMembers(), /incomplete or changed/);
  (guild as unknown as { memberCount: number }).memberCount = 1;
  changed = true;
  await assert.rejects(() => gateway.getMembers({ observation: true }), /incomplete or changed/);
  changed = false;
  assert.equal((await gateway.getMembers()).length, 1);
  (guild as unknown as { memberCount: number }).memberCount = 2;
  await assert.rejects(() => gateway.getMembers({ observation: true }), /incomplete or changed/);
});

test('guild/session scoping shares wrappers but never combines another guild or Client', async () => {
  const client = new EventEmitter();
  let fetches = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const make = (id: string, session = client) => ({ id, client: session, members: { fetch: async () => {
    fetches += 1; await held; return new Collection([['one', leagueMember('one', [])]]);
  } } }) as unknown as Guild;
  const pending = [make('a'), make('a'), make('b'), make('a', new EventEmitter())]
    .map((guild) => new DiscordLeagueGateway(guild, 'transactions').getMembers());
  release();
  await Promise.all(pending);
  assert.equal(fetches, 3);
});

test('a second throttle stops recovery rather than entering a hot retry loop', async () => {
  let now = 0;
  let fetches = 0;
  const guild = { id: 'guild', members: { fetch: async () => {
    fetches += 1;
    throw Object.assign(Error('limited'), { data: { opcode: 8, retry_after: 0.01 } });
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions', { now: () => now,
    sleep: async (ms) => { now += ms; } });
  await assert.rejects(() => gateway.getMembers(), /Gateway.*cooldown/i);
  await assert.rejects(() => gateway.getMembers({ observation: true }), /Gateway.*cooldown/i);
  assert.equal(fetches, 2);
  assert.equal(leagueMemberReadDiagnostics(guild).waits, 1);
});

test('joins, departures, role/name changes and reconnects invalidate only the affected session snapshots', async () => {
  const client = new EventEmitter();
  const member = leagueMember('one', []);
  let fetches = 0;
  const guild = { id: 'guild', shardId: 0, client, memberCount: 1, members: { fetch: async () => {
    fetches += 1; return new Collection([['one', member]]);
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  await gateway.getMembers({ observation: true });
  for (const event of ['guildMemberAdd', 'guildMemberRemove', 'roleDelete']) {
    client.emit(event, { guild });
    await gateway.getMembers({ observation: true });
  }
  client.emit('userUpdate', {}, {});
  await gateway.getMembers({ observation: true });
  client.emit('shardDisconnect', {}, 1); // Unrelated shard retains its snapshot.
  await gateway.getMembers({ observation: true });
  assert.equal(fetches, 5);
  client.emit('shardDisconnect', {}, 0);
  await gateway.getMembers({ observation: true });
  client.emit('shardResume', 0, 0);
  await gateway.getMembers({ observation: true });
  assert.equal(fetches, 7);
});

test('Discord REST and Sheets-shaped errors do not trigger Gateway retry/backoff', async () => {
  for (const error of [Object.assign(Error('REST quota'), { status: 429 }),
    Object.assign(Error('other opcode'), { data: { opcode: 1, retry_after: 0.01 } })]) {
    let fetches = 0;
    const guild = { id: 'guild', members: { fetch: async () => { fetches += 1; throw error; } } } as unknown as Guild;
    const gateway = new DiscordLeagueGateway(guild, 'transactions', { sleep: async () => assert.fail('not a Gateway wait') });
    await assert.rejects(() => gateway.getMembers(), (actual) => actual === error);
    assert.equal(fetches, 1);
  }
});

test('installed discord.js GatewayRateLimitError is recovered after a single cancellable short wait', async () => {
  const client = new Client({ intents: [] });
  const guild = (client.guilds as unknown as { _add(data: object): Guild })._add({
    id: '100', name: 'Fixture', shardId: 0, member_count: 1, roles: [], unavailable: false, channels: [],
  });
  const member = (guild.members as unknown as { _add(data: object): GuildMember })._add({
    user: { id: '200', username: 'Player', discriminator: '0', bot: false }, roles: [],
    joined_at: '2026-10-01T00:00:00Z',
  });
  let requests = 0;
  let now = 0;
  const waits: number[] = [];
  client.ws.shards.set(0, { send: (packet: { d: { nonce: string } }) => {
    requests += 1;
    if (requests === 1) client.emit('raw', { t: 'RATE_LIMITED', d: {
      opcode: 8, retry_after: 0.01, meta: { guild_id: guild.id, nonce: packet.d.nonce },
    } } as never, 0);
    else client.emit('guildMembersChunk', new Collection([[member.id, member]]), guild,
      { nonce: packet.d.nonce, count: 1, index: 0 } as never);
  } } as never);
  try {
    const gateway = new DiscordLeagueGateway(guild, 'transactions', { now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; } });
    assert.equal((await gateway.getMembers())[0]?.discordId, member.id);
    assert.deepEqual(waits, [260]);
    assert.equal(requests, 2);
    assert.equal(client.listenerCount('raw'), 0);
    assert.equal(client.listenerCount('guildMembersChunk'), 0);
  } finally { client.ws.shards.clear(); await client.destroy(); }
});

test('mutation reads refresh and use the returned complete collection, never the mutable manager cache', async () => {
  const stale = leagueMember('gone', ['team-a']);
  const current = leagueMember('here', ['team-b']);
  let fetches = 0;
  const guild = { id: 'guild', members: {
    cache: new Collection([['gone', stale]]),
    fetch: async () => { fetches += 1; return new Collection([['here', current]]); },
  } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions');
  assert.deepEqual((await gateway.getMembers()).map((member) => member.discordId), ['here']);
  current.displayName = 'Changed';
  assert.equal((await gateway.getMembers())[0]?.displayName, 'Changed');
  assert.equal(fetches, 2);
});

test('observation reads share a detached TTL snapshot; member events and expiry require another complete read', async () => {
  const client = new EventEmitter();
  const member = leagueMember('one', ['team-a']);
  const cache = new Collection([['one', member]]);
  let now = 0;
  let fetches = 0;
  const guild = { id: 'guild', client, memberCount: 1, members: { cache, fetch: async () => {
    fetches += 1; return cache;
  } } } as unknown as Guild;
  const first = new DiscordLeagueGateway(guild, 'transactions', { now: () => now });
  const second = new DiscordLeagueGateway(guild, 'transactions', { now: () => now });
  const observed = await first.getMembers({ observation: true });
  observed[0]!.roleIds.push('tampered');
  cache.clear(); // SDK cache eviction is not a proven departure.
  assert.deepEqual((await second.getMembers({ observation: true }))[0]?.roleIds, ['team-a']);
  cache.set('one', member);
  member.displayName = 'Renamed';
  client.emit('guildMemberUpdate', member, { ...member, guild });
  assert.equal((await second.getMembers({ observation: true }))[0]?.displayName, 'Renamed');
  now = 60_001;
  await first.getMembers({ observation: true });
  assert.equal(fetches, 3);
});

test('account replacement proof rejects cached member fallback and preserves explicit bot/guild identity', async () => {
  const member = { ...leagueMember('new', ['team']), guild: { id: 'g' } };
  const cache = new Collection([['new', member]]);
  let limited = false;
  const guild = { id: 'g', members: { cache, fetch: async (options?: unknown) => {
    if (options) return member;
    if (limited) throw Object.assign(Error('full member rate limit'), { data: { opcode: 8, retry_after: 1 } });
    return cache;
  } } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'notices');
  await gateway.getMembers();
  limited = true;
  await assert.rejects(() => gateway.getAccountReplacementMembers(), /Gateway.*cooldown/i);
  member.user.bot = true;
  assert.equal((await gateway.getAccountReplacementMember('new'))?.bot, true);
  assert.equal((await gateway.getAccountReplacementMember('new'))?.guildId, 'g');
});

test('account role reconciliation rejects privileged/integration roles and changes only exact managed deltas', async () => {
  const member = { ...leagueMember('new', ['fa', 'captain-access']), guild: { id: 'g' },
    roles: { cache: new Collection<string, unknown>([['fa', {}], ['captain-access', {}]]),
      remove: async (id: string) => { member.roles.cache.delete(id); },
      add: async (id: string) => { member.roles.cache.set(id, {}); } } };
  const roles = new Collection(['team', 'division', 'fa'].map((id) => [id,
    { id, guild: { id: 'g' }, managed: false, editable: true, permissions: new PermissionsBitField() }]));
  const guild = { id: 'g', members: { fetch: async () => member }, roles: { fetch: async () => roles } } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'notices');
  const change = { discordId: 'new', managedRoleIds: ['team', 'division', 'fa'], before: ['fa'], after: ['division', 'team'], remove: ['fa'], add: ['division', 'team'] };
  roles.get('team')!.managed = true;
  await assert.rejects(() => gateway.reconcileAccountReplacementRoles(change), /ownership/i);
  roles.get('team')!.managed = false;
  roles.get('team')!.permissions.add(PermissionFlagsBits.Administrator);
  await assert.rejects(() => gateway.reconcileAccountReplacementRoles(change), /ownership/i);
  assert.deepEqual([...member.roles.cache.keys()], ['fa', 'captain-access']);
  roles.get('team')!.permissions.remove(PermissionFlagsBits.Administrator);
  for (const permission of [PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ManageEvents, PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ManageGuildExpressions]) {
    roles.get('team')!.permissions.add(permission);
    await assert.rejects(() => gateway.reconcileAccountReplacementRoles(change), /ownership/i);
    assert.deepEqual([...member.roles.cache.keys()], ['fa', 'captain-access']);
    roles.get('team')!.permissions.remove(permission);
  }
  await gateway.reconcileAccountReplacementRoles(change);
  assert.deepEqual([...member.roles.cache.keys()].sort(), ['captain-access', 'division', 'team']);
});

test('installed discord.js role deltas converge without any gateway cache updates', async () => {
  const client = new Client({ intents: [] });
  const users = client.users as unknown as { _add(data: object): ClientUser };
  const guilds = client.guilds as unknown as { _add(data: object): Guild };
  client.user = users._add({ id: 'bot', username: 'Bot', discriminator: '0', bot: true });
  const guild = guilds._add({ id: '100', name: 'Fixture', roles: ['100', 'fa', 'team', 'division', 'unmanaged']
    .map((id, position) => ({ id, name: id, position, permissions: '0' })) });
  const manager = guild.members as unknown as { _add(data: object): GuildMember };
  const serverRoles = new Set(['fa', 'unmanaged']);
  const rawMember = () => ({ user: { id: '200', username: 'New', discriminator: '0', bot: false }, roles: [...serverRoles], joined_at: '2026-10-01T00:00:00Z' });
  guild.members.fetch = (async () => manager._add(rawMember())) as unknown as typeof guild.members.fetch;
  const routes: string[] = [];
  client.rest.patch = async () => assert.fail('A stale whole-role PATCH must never be used');
  client.rest.put = async route => { routes.push(`PUT ${route}`); serverRoles.add(String(route).split('/').at(-1)!); };
  client.rest.delete = async route => { routes.push(`DELETE ${route}`); serverRoles.delete(String(route).split('/').at(-1)!); };
  const gateway = new DiscordLeagueGateway(guild, 'notices');
  gateway.assertAccountReplacementRoleOwnership = async () => {};
  try {
    await gateway.reconcileAccountReplacementRoles({ discordId: '200', managedRoleIds: ['team', 'division', 'fa'],
      before: ['fa'], after: ['division', 'team'], remove: ['fa'], add: ['division', 'team'] });
    assert.deepEqual([...serverRoles].sort(), ['division', 'team', 'unmanaged']);
    assert.equal(routes.length, 3);
    assert.match(routes[0]!, /^DELETE .*\/fa$/);
  } finally { client.destroy(); }
});

test('sequential mutation reads recheck role changes rather than reusing an observation snapshot', async () => {
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
  assert.equal(fetches, 2);
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

test('a Gateway cooldown is shared, honors a long retry_after and never falls back to an expired snapshot', async () => {
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
        if (fetches === 1 || fetches === 3) return cache;
        throw Object.assign(new Error('Request with opcode 8 was rate limited.'), {
          data: { opcode: 8, retry_after: 120.1 },
        });
      },
    },
  } as unknown as Guild;
  const gateway = new DiscordLeagueGateway(guild, 'transactions', { now: () => now });

  await gateway.getMembers();
  now = 60_001;
  member.roles.cache.set('division-v', {});
  await assert.rejects(() => gateway.getMembers(), /Gateway.*cooldown/i);
  const other = new DiscordLeagueGateway(guild, 'transactions', { now: () => now });
  now = 120_002; // More than the old 60-second clamp, still inside Discord's cooldown.
  await assert.rejects(() => other.getMembers({ observation: true }), /Gateway.*cooldown/i);
  assert.equal(fetches, 2);
  now = 180_352;
  assert.deepEqual((await other.getMembers())[0]?.roleIds.sort(), ['division-v', 'team-a']);
  assert.equal(fetches, 3);
});

test('a first full-member rate limit waits for Discord and retries once', async () => {
  const member = leagueMember('one', ['team-a']);
  const cache = new Collection<string, any>([['one', member]]);
  let fetches = 0;
  const waits: number[] = [];
  let now = 0;
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
    now: () => now,
    sleep: async (delayMs) => { waits.push(delayMs); now += delayMs; },
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
