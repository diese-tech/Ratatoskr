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
  { createSeason, insertManagedResource, openDatabase, setActiveSeason, setSeasonDiscordCategoryId },
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
