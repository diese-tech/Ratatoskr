import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationCommandOptionType, ChannelType, Collection, MessageFlags } from 'discord.js';
import type { ScoutConfig } from '../db/types.js';
import type { ScoutConfigurationStore } from '../storage/index.js';
import { handleScoutCommand, handleScoutConfigRoleSelect, scoutCommand } from './scout.js';

test('/scout exposes create, cancel, and the admin configuration surface', () => {
  const command = scoutCommand.toJSON();
  assert.equal(command.name, 'scout');

  assert.deepEqual(command.options?.map((option) => option.name), ['create', 'cancel', 'config']);
  for (const subcommandName of ['create']) {
    const subcommand: any = command.options?.find((option) => option.name === subcommandName);
    assert.ok(subcommand && subcommand.type === ApplicationCommandOptionType.Subcommand);
    if (subcommand.type !== ApplicationCommandOptionType.Subcommand) throw new Error(`${subcommandName} must be a subcommand`);
    assert.deepEqual(subcommand.options?.map((option: { name: string }) => option.name), ['division']);
    assert.equal(subcommand.options?.[0]?.required, true);
  }
  const cancel: any = command.options?.find((option) => option.name === 'cancel');
  assert.deepEqual(cancel.options ?? [], [], 'cancel must not require a division');
  const config = command.options?.find((option) => option.name === 'config');
  assert.ok(config);
  assert.equal(config.type, ApplicationCommandOptionType.Subcommand);
  if (config.type !== ApplicationCommandOptionType.Subcommand) throw new Error('config must be a subcommand');
  assert.deepEqual(
    config.options?.map((option) => option.name),
    ['timezone', 'bind_emoji', 'operations_channel'],
  );
});

test('Scout configuration role selection awaits persistence before updating the private view', async () => {
  process.env.ROLE_ALLFATHER_ID = 'admin-role';
  process.env.ROLE_AESIR_ID = 'other-admin-role';
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  const config: ScoutConfig = {
    guildId: 'guild-1',
    authorizedRoleIds: ['staff-role'],
    operationsCategoryId: null,
    operationsChannelId: null,
    emojiByRole: { solo: null, jungle: null, mid: null, support: null, carry: null, fill: null },
    timezone: 'America/New_York',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
  const storage = {
    async ensureScoutConfig() { throw new Error('not used'); },
    async setScoutAuthorizedRoleIds() {
      announceWrite();
      await writeGate;
      return config;
    },
    async setScoutOperationsChannel() { throw new Error('not used'); },
    async setScoutTimezone() { throw new Error('not used'); },
    async setScoutEmojiByRole() { throw new Error('not used'); },
  } satisfies ScoutConfigurationStore;
  let deferredUpdates = 0;
  const updates: unknown[] = [];
  const edits: unknown[] = [];
  const interaction = {
    customId: 'scout:config:authorized_roles',
    guild: {
      id: 'guild-1',
      members: {
        fetch: async () => ({ roles: { cache: new Collection([['admin-role', {}]]) } }),
      },
    },
    user: { id: 'admin-1' },
    values: ['staff-role'],
    deferUpdate: async () => { deferredUpdates += 1; },
    update: async (payload: unknown) => { updates.push(payload); },
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never;

  const handling = handleScoutConfigRoleSelect(interaction, storage);
  await writeStarted;
  const acknowledgementsBeforeWrite = deferredUpdates;
  releaseWrite();
  assert.equal(await handling, true);
  assert.equal(acknowledgementsBeforeWrite, 1);
  assert.equal(updates.length, 0);
  assert.equal(edits.length, 1);
});

test('/scout config defers before awaiting asynchronous configuration reads', async () => {
  process.env.ROLE_ALLFATHER_ID = 'admin-role';
  process.env.ROLE_AESIR_ID = 'other-admin-role';
  let releaseRead!: () => void;
  let announceRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { announceRead = resolve; });
  const config: ScoutConfig = {
    guildId: 'guild-1',
    authorizedRoleIds: [],
    operationsCategoryId: null,
    operationsChannelId: null,
    emojiByRole: { solo: null, jungle: null, mid: null, support: null, carry: null, fill: null },
    timezone: 'America/New_York',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
  const storage = {
    async ensureScoutConfig() {
      announceRead();
      await readGate;
      return config;
    },
    async setScoutAuthorizedRoleIds() { throw new Error('not used'); },
    async setScoutOperationsChannel() { throw new Error('not used'); },
    async setScoutTimezone() { throw new Error('not used'); },
    async setScoutEmojiByRole() { throw new Error('not used'); },
  } satisfies ScoutConfigurationStore;
  let deferredReplies = 0;
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const interaction = {
    guild: {
      id: 'guild-1',
      members: {
        fetch: async () => ({ roles: { cache: new Collection([['admin-role', {}]]) } }),
      },
    },
    user: { id: 'admin-1' },
    options: {
      getSubcommand: () => 'config',
      getString: () => null,
      getChannel: () => null,
      getBoolean: () => false,
    },
    deferReply: async () => { deferredReplies += 1; },
    reply: async (payload: unknown) => { replies.push(payload); },
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never;

  const handling = handleScoutCommand(interaction, {} as never, storage, {} as never);
  await readStarted;
  const acknowledgementsBeforeRead = deferredReplies;
  releaseRead();
  await handling;
  assert.equal(acknowledgementsBeforeRead, 1);
  assert.equal(replies.length, 0);
  assert.equal(edits.length, 1);
});

test('/scout config keeps invalid operations-channel errors private when emoji binding is requested', async () => {
  process.env.ROLE_ALLFATHER_ID = 'admin-role';
  process.env.ROLE_AESIR_ID = 'other-admin-role';
  let configurationReads = 0;
  const storage = {
    async ensureScoutConfig() { configurationReads += 1; throw new Error('validation must happen first'); },
    async setScoutAuthorizedRoleIds() { throw new Error('not used'); },
    async setScoutOperationsChannel() { throw new Error('not used'); },
    async setScoutTimezone() { throw new Error('not used'); },
    async setScoutEmojiByRole() { throw new Error('not used'); },
  } satisfies ScoutConfigurationStore;
  const replies: any[] = [];
  const deferredReplies: any[] = [];
  const edits: unknown[] = [];
  const selectedChannel = { id: 'channel-1' };
  const interaction = {
    guild: {
      id: 'guild-1',
      members: {
        fetch: async () => ({ roles: { cache: new Collection([['admin-role', {}]]) } }),
      },
      channels: {
        fetch: async () => {
          assert.equal(deferredReplies.length, 1, 'channel validation must start after acknowledgement');
          return { id: 'channel-1', type: ChannelType.GuildText, parentId: null };
        },
      },
    },
    user: { id: 'admin-1' },
    options: {
      getSubcommand: () => 'config',
      getString: () => null,
      getChannel: () => selectedChannel,
      getBoolean: () => true,
    },
    deferReply: async (payload: unknown) => { deferredReplies.push(payload); },
    reply: async (payload: unknown) => { replies.push(payload); },
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never;

  await handleScoutCommand(interaction, {} as never, storage, {} as never);

  assert.equal(configurationReads, 0);
  assert.equal(deferredReplies.length, 1);
  assert.equal(deferredReplies[0].flags, MessageFlags.Ephemeral);
  assert.equal(replies.length, 0);
  assert.equal(edits.length, 1);
  assert.match((edits[0] as { content: string }).content, /inside a category/);
});
