import assert from 'node:assert/strict';
import { ChannelType, Collection, type Guild } from 'discord.js';
import { test } from 'node:test';
import type { DivisionSpec } from '../config/guild-structure.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import {
  classifyDivisionChannelMatch,
  getDivisionSpec,
  getDivisionTemplate,
  getExpectedChannelNames,
  isDivisionKey,
  provisionDivision,
} from './divisions.js';

test('isDivisionKey recognizes every configured division key and rejects unknown ones', () => {
  assert.equal(isDivisionKey('vanaheim'), true);
  assert.equal(isDivisionKey('svartalfheim'), true);
  assert.equal(isDivisionKey('niflheim'), false);
});

test('getDivisionSpec resolves a known key and throws on an unknown one', () => {
  assert.equal(getDivisionSpec('vanaheim').name, 'Vanaheim');
  assert.throws(() => getDivisionSpec('niflheim' as never), /Unknown division key: niflheim/);
});

test('getDivisionTemplate: renaming a division\'s display name alone (key unchanged) never changes any channel\'s key -- #31 Defect 1/Defect 2', () => {
  // This is the division-domain equivalent of the server/season config-side
  // rename regression tests: a display-name-only rename must change every
  // presentational channel *name* (they're slug-derived from the division's
  // current name) but must never change a channel's *key*, since the key --
  // not the name -- is what getActiveManagedResourceByLogicalKey resolves
  // identity by. If this ever regressed, a division rename would silently
  // orphan every one of its managed channels and create duplicates.
  const original: DivisionSpec = { key: 'vanaheim', name: 'Vanaheim' };
  const renamedDisplayNameOnly: DivisionSpec = { key: 'vanaheim', name: 'Vanir Prime' };

  const originalKeys = getDivisionTemplate(original).channels.map((channel) => channel.key);
  const renamedKeys = getDivisionTemplate(renamedDisplayNameOnly).channels.map((channel) => channel.key);
  assert.deepEqual(renamedKeys, originalKeys);

  const originalNames = getDivisionTemplate(original).channels.map((channel) => channel.name);
  const renamedNames = getDivisionTemplate(renamedDisplayNameOnly).channels.map((channel) => channel.name);
  assert.notDeepEqual(renamedNames, originalNames, 'channel names ARE expected to change -- they are presentational');
});

test('getDivisionTemplate: channel names are division-prefixed text (kebab-case) and title-cased voice, matching the existing live naming convention', () => {
  const template = getDivisionTemplate({ key: 'vanaheim', name: 'Vanaheim' });
  const byKey = new Map(template.channels.map((channel) => [channel.key, channel.name]));

  assert.equal(byKey.get('captain_chat'), 'vanaheim-captain-chat');
  assert.equal(byKey.get('general'), 'vanaheim-general');
  assert.equal(byKey.get('lobby'), 'Vanaheim Lobby');
});

test('getExpectedChannelNames includes the division scout signup and results channels', () => {
  const names = getExpectedChannelNames({ key: 'alfheim', name: 'Alfheim' });
  assert.deepEqual(names, [
    'alfheim-captain-chat',
    'alfheim-announcements',
    'alfheim-general',
    'alfheim-tier-list',
    'alfheim-scheduling',
    'alfheim-match-reports',
    'alfheim-scout-signups',
    'alfheim-scout-results',
    'Alfheim Lobby',
  ]);
});

test('classifyDivisionChannelMatch adopts one legacy unprefixed scout channel from the expected division category', () => {
  const result = classifyDivisionChannelMatch(
    [
      { discordId: 'vanaheim-signups', name: 'scout-signups', kind: 'text_channel', parentId: 'vanaheim-category' },
      { discordId: 'alfheim-signups', name: 'scout-signups', kind: 'text_channel', parentId: 'alfheim-category' },
      { discordId: 'wrong-type', name: 'scout-signups', kind: 'voice_channel', parentId: 'vanaheim-category' },
    ],
    {
      name: 'vanaheim-scout-signups',
      kind: 'text_channel',
      parentId: 'vanaheim-category',
      legacyName: 'scout-signups',
    },
  );

  assert.equal(result.outcome, 'exact');
  assert.equal(result.outcome === 'exact' && result.candidate.discordId, 'vanaheim-signups');
  assert.equal(result.outcome === 'exact' && result.source, 'legacy');
});

test('getDivisionTemplate declares unprefixed legacy adoption names only for scout channels', () => {
  const template = getDivisionTemplate({ key: 'vanaheim', name: 'Vanaheim' });
  const legacyByKey = new Map(template.channels.map((channel) => [channel.key, channel.legacyName]));

  assert.equal(legacyByKey.get('scout_signups'), 'scout-signups');
  assert.equal(legacyByKey.get('scout_results'), 'scout-results');
  assert.equal(legacyByKey.get('general'), undefined);
});

test('classifyDivisionChannelMatch refuses multiple legacy scout channels in the expected category', () => {
  const result = classifyDivisionChannelMatch(
    [
      { discordId: 'legacy-1', name: 'scout-signups', kind: 'text_channel', parentId: 'vanaheim-category' },
      { discordId: 'legacy-2', name: 'scout-signups', kind: 'text_channel', parentId: 'vanaheim-category' },
    ],
    {
      name: 'vanaheim-scout-signups',
      kind: 'text_channel',
      parentId: 'vanaheim-category',
      legacyName: 'scout-signups',
    },
  );

  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(result.outcome === 'ambiguous' && result.candidates.map((candidate) => candidate.discordId), [
    'legacy-1',
    'legacy-2',
  ]);
});

test('provisionDivision adopts and renames exact legacy scout channels without creating replacements', async () => {
  const db = openDatabase(':memory:');
  const renamed: Array<[string, string]> = [];
  const division = getDivisionSpec('vanaheim');
  const template = getDivisionTemplate(division);
  const categoryId = 'vanaheim-category';

  const roles = new Collection<string, any>([
    ['everyone', { id: 'everyone', name: '@everyone' }],
    ['division-role', { id: 'division-role', name: 'Vanaheim' }],
    ['captain-access', { id: 'captain-access', name: 'Vanaheim Captain Access' }],
  ]);
  const channels = new Collection<string, any>();
  channels.set(categoryId, {
    id: categoryId,
    name: 'Vanaheim',
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionOverwrites: { set: async () => undefined },
  });

  for (const channelSpec of template.channels) {
    const id = `channel-${channelSpec.key}`;
    const legacyName = channelSpec.legacyName ?? channelSpec.name;
    channels.set(id, {
      id,
      name: legacyName,
      type: channelSpec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
      parentId: categoryId,
      isThread: () => false,
      permissionOverwrites: { set: async () => undefined },
      lockPermissions: async () => undefined,
      setName: async function (nextName: string) {
        renamed.push([id, nextName]);
        this.name = nextName;
        return this;
      },
    });
  }

  const guild = {
    id: 'guild-1',
    roles: {
      everyone: roles.get('everyone'),
      cache: roles,
      fetch: async () => roles,
      create: async () => {
        throw new Error('No role should be created');
      },
    },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async () => {
        throw new Error('No channel should be created');
      },
    },
  } as unknown as Guild;

  try {
    await provisionDivision(db, guild, 'vanaheim');
    assert.deepEqual(renamed, [
      ['channel-scout_signups', 'vanaheim-scout-signups'],
      ['channel-scout_results', 'vanaheim-scout-results'],
    ]);
  } finally {
    closeDatabase(db);
  }
});
