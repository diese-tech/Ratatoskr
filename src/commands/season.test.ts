import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationCommandOptionType,
  ChannelType,
  Collection,
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
} from 'discord.js';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';

const [
  { handleSeasonCommand, seasonCommand },
  {
    createSeason,
    getActiveSeason,
    getSeasonByNumber,
    insertManagedResource,
    openDatabase,
    setActiveSeason,
    setSeasonDiscordCategoryId,
  },
] = await Promise.all([import('./season.js'), import('../db/index.js')]);

function statusInteraction(number: number | null = null, channels = new Collection<string, object>()) {
  const replies: InteractionReplyOptions[] = [];
  const events: string[] = [];
  const member = { roles: { cache: new Collection([[process.env.ROLE_ALLFATHER_ID!, {}]]) } };
  const guild = {
    id: 'guild',
    members: { fetch: async () => member },
    channels: { cache: channels, fetch: async () => { events.push('fetch-channels'); } },
  };
  const interaction = {
    guild,
    user: { id: 'admin' },
    options: {
      getSubcommand: () => 'status',
      getInteger: () => number,
    },
    reply: async (payload: InteractionReplyOptions) => {
      events.push('reply');
      replies.push(payload);
    },
    deferReply: async (payload: InteractionReplyOptions) => {
      events.push(payload.flags === MessageFlags.Ephemeral ? 'defer-ephemeral' : 'defer');
    },
    editReply: async (payload: InteractionReplyOptions) => {
      events.push('edit-reply');
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies, events };
}

function closeInteraction(confirm: boolean | null = null, guildOverride?: object) {
  const replies: InteractionReplyOptions[] = [];
  const member = { roles: { cache: new Collection([[process.env.ROLE_ALLFATHER_ID!, {}]]) } };
  const guild = guildOverride ?? {
    id: 'guild',
    members: { fetch: async () => member },
  };
  const interaction = {
    guild,
    user: { id: 'admin' },
    options: {
      getSubcommand: () => 'close',
      getBoolean: () => confirm,
    },
    reply: async (payload: InteractionReplyOptions) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

function createInteraction(seasonNumber: number, guildOverride?: object) {
  const replies: unknown[] = [];
  const channels = new Collection<string, object>();
  const member = { roles: { cache: new Collection([[process.env.ROLE_ALLFATHER_ID!, {}]]) } };
  let nextChannelId = 0;
  const guild = guildOverride ?? {
    id: 'guild',
    members: { fetch: async () => member },
    channels: {
      cache: channels,
      fetch: async () => undefined,
      create: async (options: { name: string; type: ChannelType; parent?: string }) => {
        const id = `created-channel-${++nextChannelId}`;
        const channel = options.type === ChannelType.GuildCategory
          ? { id, name: options.name, type: options.type, parentId: null }
          : {
              id,
              name: options.name,
              type: options.type,
              parentId: options.parent ?? null,
              permissionOverwrites: { set: async () => undefined },
            };
        channels.set(id, channel);
        return channel;
      },
    },
    roles: {
      everyone: { id: 'everyone' },
      cache: new Collection<string, { name: string }>(),
      fetch: async () => undefined,
    },
  };
  const interaction = {
    guild,
    user: { id: 'admin' },
    options: {
      getSubcommand: () => 'create',
      getInteger: () => seasonNumber,
      getString: () => null,
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies, guild };
}

test('/season status without a number reports when there is no active season', async () => {
  const db = openDatabase(':memory:');
  const { interaction, replies } = statusInteraction();

  try {
    await handleSeasonCommand(interaction, db);
    assert.deepEqual(replies, [{ content: 'No season is currently active.', flags: MessageFlags.Ephemeral }]);
  } finally {
    db.close();
  }
});

test('/season exposes status with an optional season number', () => {
  const command = seasonCommand.toJSON();
  const status = command.options?.find((option) => option.name === 'status');
  assert.equal(status?.type, ApplicationCommandOptionType.Subcommand);
  if (status?.type !== ApplicationCommandOptionType.Subcommand) throw new Error('status must be a subcommand');
  assert.deepEqual(status.options?.map((option) => option.name), ['number']);
  assert.equal(status.options?.[0]?.required, false);
});

test('/season exposes close with an optional confirmation flag', () => {
  const command = seasonCommand.toJSON();
  const close = command.options?.find((option) => option.name === 'close');
  assert.equal(close?.type, ApplicationCommandOptionType.Subcommand);
  if (close?.type !== ApplicationCommandOptionType.Subcommand) throw new Error('close must be a subcommand');
  assert.deepEqual(close.options?.map((option) => option.name), ['confirm']);
  assert.equal(close.options?.[0]?.type, ApplicationCommandOptionType.Boolean);
  assert.equal(close.options?.[0]?.required, false);
});

test('/season close reports no active season without mutating persistence', async () => {
  const db = openDatabase(':memory:');
  createSeason(db, { guildId: 'guild', seasonNumber: 1 });
  const before = db.serialize();
  const { interaction, replies } = closeInteraction(true);

  try {
    await handleSeasonCommand(interaction, db);
    assert.deepEqual(replies, [{ content: 'No season is currently active.', flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(db.serialize(), before);
  } finally {
    db.close();
  }
});

test('/season close previews the active season without mutating persistence when confirmation is omitted or false', async () => {
  const db = openDatabase(':memory:');
  const season = createSeason(db, { guildId: 'guild', seasonNumber: 5, displayName: 'Season of the Tree' });
  setActiveSeason(db, 'guild', season.id);
  const before = db.serialize();

  try {
    for (const confirm of [null, false]) {
      const { interaction, replies } = closeInteraction(confirm);
      await handleSeasonCommand(interaction, db);
      assert.deepEqual(replies, [{
        content: [
          '**Close season 5?**',
          'Category: Season of the Tree',
          'This archives the season record and cannot be undone. Its Discord category and channels will remain unchanged.',
          'Re-run `/season close confirm:true` to continue.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      }]);
    }
    assert.deepEqual(db.serialize(), before);
  } finally {
    db.close();
  }
});

test('/season close confirm:true archives the active season without touching Discord resources', async () => {
  const db = openDatabase(':memory:');
  const season = createSeason(db, { guildId: 'guild', seasonNumber: 5, displayName: 'Season of the Tree' });
  setSeasonDiscordCategoryId(db, season.id, 'season-category');
  setActiveSeason(db, 'guild', season.id);
  const { interaction, replies } = closeInteraction(true);

  try {
    await handleSeasonCommand(interaction, db);
    assert.deepEqual(replies, [{
      content: 'Season 5 (Season of the Tree) is now archived. Its Discord category and channels were not changed.',
      flags: MessageFlags.Ephemeral,
    }]);
    assert.equal(getActiveSeason(db, 'guild'), undefined);
    const archived = getSeasonByNumber(db, 'guild', 5);
    assert.equal(archived?.status, 'archived');
    assert.ok(archived?.archivedAt);
    assert.equal(archived?.discordCategoryId, 'season-category');
  } finally {
    db.close();
  }
});

test('/season create can provision and activate the next season while retaining the archived season channels', async () => {
  const db = openDatabase(':memory:');
  const firstCreate = createInteraction(1);
  const close = closeInteraction(true, firstCreate.guild);
  const nextCreate = createInteraction(2, firstCreate.guild);

  try {
    await handleSeasonCommand(firstCreate.interaction, db);
    assert.equal(getActiveSeason(db, 'guild')?.seasonNumber, 1);
    assert.match(String(firstCreate.replies[0]), /Season 1 \(YSL Season 1\) is provisioned and now active\./);

    await handleSeasonCommand(close.interaction, db);
    await handleSeasonCommand(nextCreate.interaction, db);

    assert.match(String(nextCreate.replies[0]), /Season 2 \(YSL Season 2\) is provisioned and now active\./);
    assert.equal(getSeasonByNumber(db, 'guild', 1)?.status, 'archived');
    assert.equal(getActiveSeason(db, 'guild')?.seasonNumber, 2);
  } finally {
    db.close();
  }
});

test('/season close fails closed if the targeted season stops being active before the archive write', async () => {
  const db = openDatabase(':memory:');
  const observed = createSeason(db, { guildId: 'guild', seasonNumber: 1 });
  const replacement = createSeason(db, { guildId: 'guild', seasonNumber: 2 });
  setActiveSeason(db, 'guild', observed.id);
  let injectedRace = false;
  const racingDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (source: string) => {
          if (!injectedRace && source.includes("SET status = 'archived'")) {
            injectedRace = true;
            setActiveSeason(db, 'guild', replacement.id);
          }
          return db.prepare(source);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { interaction, replies } = closeInteraction(true);

  try {
    await handleSeasonCommand(interaction, racingDb);
    assert.deepEqual(replies, [{
      content: 'The active season changed before it could be closed. No change was made; run `/season close` again.',
      flags: MessageFlags.Ephemeral,
    }]);
    assert.equal(getSeasonByNumber(db, 'guild', 1)?.status, 'inactive');
    assert.equal(getActiveSeason(db, 'guild')?.id, replacement.id);
  } finally {
    db.close();
  }
});

test('/season status reports a requested season that does not exist', async () => {
  const db = openDatabase(':memory:');
  const { interaction, replies } = statusInteraction(12);

  try {
    await handleSeasonCommand(interaction, db);
    assert.deepEqual(replies, [{ content: 'Season 12 does not exist.', flags: MessageFlags.Ephemeral }]);
  } finally {
    db.close();
  }
});

test('/season status without a number selects the active season and reports a stale category', async () => {
  const db = openDatabase(':memory:');
  createSeason(db, { guildId: 'guild', seasonNumber: 3 });
  const active = createSeason(db, { guildId: 'guild', seasonNumber: 5 });
  setSeasonDiscordCategoryId(db, active.id, 'deleted-category');
  setActiveSeason(db, 'guild', active.id);
  const { interaction, replies } = statusInteraction();

  try {
    await handleSeasonCommand(interaction, db);
    assert.match(String(replies[0]?.content), /^\*\*Season 5 status\*\*/);
    assert.match(String(replies[0]?.content), /Lifecycle status: active/);
    assert.match(String(replies[0]?.content), /Category: stale/);
    assert.equal(String(replies[0]?.content).match(/: missing/g)?.length, 5);
  } finally {
    db.close();
  }
});

test('/season status reports present, missing, and stale resources for a numbered inactive season', async () => {
  const db = openDatabase(':memory:');
  const season = createSeason(db, { guildId: 'guild', seasonNumber: 4 });
  setSeasonDiscordCategoryId(db, season.id, 'season-category');
  insertManagedResource(db, {
    discordResourceId: 'banned-channel',
    guildId: 'guild',
    resourceType: 'text_channel',
    logicalKey: 'season:4:channel:banned_content:text_channel',
    parentResourceId: 'season-category',
    scaffoldDomain: 'season',
  });
  insertManagedResource(db, {
    discordResourceId: 'schedule-channel',
    guildId: 'guild',
    resourceType: 'text_channel',
    logicalKey: 'season:4:channel:schedule:text_channel',
    parentResourceId: 'season-category',
    scaffoldDomain: 'season',
  });
  insertManagedResource(db, {
    discordResourceId: 'standings-channel',
    guildId: 'guild',
    resourceType: 'text_channel',
    logicalKey: 'season:4:channel:standings:text_channel',
    parentResourceId: 'season-category',
    scaffoldDomain: 'season',
  });

  const channels = new Collection<string, object>([
    ['season-category', { id: 'season-category', type: ChannelType.GuildCategory }],
    ['banned-channel', { id: 'banned-channel', type: ChannelType.GuildText, parentId: 'season-category' }],
    ['standings-channel', { id: 'standings-channel', type: ChannelType.GuildText, parentId: 'wrong-category' }],
  ]);
  const { interaction, replies, events } = statusInteraction(4, channels);
  const before = db.serialize();

  try {
    await handleSeasonCommand(interaction, db);
    assert.equal(replies.length, 1);
    assert.equal(events[0], 'defer-ephemeral');
    assert.equal(
      replies[0]?.content,
      [
        '**Season 4 status**',
        'Lifecycle status: inactive',
        'Category: present',
        'Channels:',
        '- banned-content: present',
        '- schedule: stale',
        '- standings: misparented',
        '- rosters: missing',
        '- transactions: missing',
      ].join('\n'),
    );
    assert.deepEqual(db.serialize(), before, 'status must not mutate season or managed-resource state');
  } finally {
    db.close();
  }
});

test('/season status defers ephemerally before fetching Discord channels', async () => {
  const db = openDatabase(':memory:');
  createSeason(db, { guildId: 'guild', seasonNumber: 4 });
  const { interaction, events } = statusInteraction(4);

  try {
    await handleSeasonCommand(interaction, db);
    assert.deepEqual(events.slice(0, 2), ['defer-ephemeral', 'fetch-channels']);
  } finally {
    db.close();
  }
});
