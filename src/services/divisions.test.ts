import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits, type Guild } from 'discord.js';
import { test } from 'node:test';
import type { DivisionSpec } from '../config/guild-structure.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { insertManagedResource, listManagedResourcesByDomain, setManagedResourceParent } from '../db/repositories/managedResources.js';
import { setScoutOperationsChannel } from '../db/repositories/scoutConfig.js';
import { divisionChannelLogicalKey } from './divisionScaffold.js';
import {
  classifyDivisionChannelMatch,
  getDivisionSpec,
  getDivisionTemplate,
  getExpectedChannelNames,
  isDivisionKey,
  provisionDivision,
  resolveDivisionPermissionOverwrites,
} from './divisions.js';

test('concurrent division provisioning creates and tracks the shared franchise role once', async () => {
  const db = openDatabase(':memory:');
  const roles = new Collection<string, any>();
  let sharedCreates = 0;
  const guild = { id: 'concurrent-guild', roles: { cache: roles, fetch: async () => roles,
    create: async ({ name }: { name: string }) => {
      if (name !== 'Franchise Representative') throw new Error('Reached division-specific work');
      const id = `shared-${++sharedCreates}`;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const role = { id, name };
      roles.set(id, role);
      return role;
    },
  }, channels: { fetch: async () => undefined } } as unknown as Guild;
  try {
    const results = await Promise.allSettled([
      provisionDivision(db, guild, 'vanaheim'), provisionDivision(db, guild, 'alfheim'),
    ]);
    assert.equal(sharedCreates, 1);
    assert.equal(roles.size, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(result.reason.message, /Reached division-specific work/);
    }
    assert.equal(listManagedResourcesByDomain(db, guild.id, 'server').filter((row) => row.logicalKey === 'server:role:franchise_representative').length, 1);
  } finally { db.close(); }
});

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

  assert.equal(template.managerRoleName, 'Vanaheim Manager');
  assert.equal(template.captainRoleName, 'Vanaheim Captain');
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

test('division channels declare the approved posting and visibility profiles', () => {
  const template = getDivisionTemplate({ key: 'vanaheim', name: 'Vanaheim' });
  const profiles = new Map(template.channels.map((channel) => [channel.key, channel.permissionProfile]));

  assert.equal(profiles.get('captain_chat'), 'captain_only');
  assert.equal(profiles.get('announcements'), 'announcements');
  assert.equal(profiles.get('scheduling'), 'captain_work');
  assert.equal(profiles.get('match_reports'), 'captain_work');
  assert.equal(profiles.get('scout_signups'), 'scout_signups');
  assert.equal(profiles.get('scout_results'), 'scout_results');
  assert.equal(profiles.get('general'), undefined);
  assert.equal(profiles.get('tier_list'), undefined);
  assert.equal(profiles.get('lobby'), undefined);
});

const permissionRoleIds = {
  everyone: 'everyone',
  division: 'division',
  manager: 'manager',
  captain: 'captain',
  franchiseRepresentative: 'franchise',
  admins: ['allfather', 'aesir'],
};

const NO_POST_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.SendVoiceMessages,
  PermissionFlagsBits.SendPolls,
];

test('division categories are visible to members, managers, captains, franchise representatives, and admins', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'category');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  assert.deepEqual(byId.get('everyone')?.deny, [PermissionFlagsBits.ViewChannel]);
  for (const roleId of ['division', 'manager', 'captain', 'franchise', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel]);
  }
});

test('captain chat is visible only to division managers, division captains, and admins', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'captain_only');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  assert.deepEqual(byId.get('everyone')?.deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(byId.has('franchise'), false);
  assert.equal(byId.has('division'), false);
  for (const roleId of ['manager', 'captain', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel]);
  }
});

test('announcement channels allow only division managers and admins to post or use threads', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'announcements');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  assert.deepEqual(byId.get('everyone')?.deny, [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS]);
  for (const roleId of ['manager', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS]);
  }
});

test('announcement channels remain visible to division members, captains, and franchise representatives', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'announcements');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  for (const roleId of ['division', 'captain', 'franchise']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel]);
  }
  assert.equal(byId.get('everyone')?.deny.includes(PermissionFlagsBits.ViewChannel), true);
});

test('scheduling and match reports allow division managers, division captains, and admins to post', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'captain_work');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  assert.deepEqual(byId.get('everyone')?.deny, [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS]);
  for (const roleId of ['manager', 'captain', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS]);
  }
  for (const roleId of ['division', 'franchise']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel]);
  }
});

test('scout signups let players react while managers, captains, franchise representatives, and admins may post', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'scout_signups');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));

  assert.deepEqual(byId.get('everyone')?.deny, [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS]);
  assert.equal(byId.get('everyone')?.deny.includes(PermissionFlagsBits.AddReactions), false);
  for (const roleId of ['manager', 'captain', 'franchise', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, ...NO_POST_PERMISSIONS]);
  }
  assert.deepEqual(byId.get('division')?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions]);
});

test('scout results restrict posting, threads, and new reactions to its approved writers', () => {
  const overwrites = resolveDivisionPermissionOverwrites(permissionRoleIds, 'scout_results');
  const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));
  const restricted = [PermissionFlagsBits.ViewChannel, ...NO_POST_PERMISSIONS, PermissionFlagsBits.AddReactions];

  assert.deepEqual(byId.get('everyone')?.deny, restricted);
  for (const roleId of ['manager', 'captain', 'franchise', 'allfather', 'aesir']) {
    assert.deepEqual(byId.get(roleId)?.allow, restricted);
  }
  assert.deepEqual(byId.get('division')?.allow, [PermissionFlagsBits.ViewChannel]);
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

test('getDivisionTemplate declares safe unprefixed legacy adoption names for every text channel', () => {
  const template = getDivisionTemplate({ key: 'vanaheim', name: 'Vanaheim' });
  const legacyByKey = new Map(template.channels.map((channel) => [channel.key, channel.legacyName]));

  assert.equal(legacyByKey.get('scout_signups'), 'scout-signups');
  assert.equal(legacyByKey.get('scout_results'), 'scout-results');
  assert.equal(legacyByKey.get('captain_chat'), 'captain-chat');
  assert.equal(legacyByKey.get('general'), 'general');
  assert.equal(legacyByKey.get('lobby'), undefined);
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

test('provisionDivision adopts and renames the observed legacy division channels without creating replacements', async () => {
  const db = openDatabase(':memory:');
  const renamed: Array<[string, string]> = [];
  const renamedRoles: Array<[string, string]> = [];
  const assignedRoles: string[] = [];
  const moved: Array<[string, string]> = [];
  const division = getDivisionSpec('vanaheim');
  const template = getDivisionTemplate(division);
  const categoryId = 'vanaheim-category';

  const roles = new Collection<string, any>([
    ['everyone', { id: 'everyone', name: '@everyone' }],
    ['division-role', { id: 'division-role', name: 'Vanaheim' }],
    ['manager-role', { id: 'manager-role', name: 'Vanaheim Manager' }],
    ['captain-role', {
      id: 'captain-role',
      name: 'Vanaheim Captain Access',
      setName: async function (nextName: string) {
        renamedRoles.push([this.id, nextName]);
        this.name = nextName;
        return this;
      },
    }],
    ['franchise-role', { id: 'franchise-role', name: 'Franchise Representative' }],
    ['allfather-role', { id: 'allfather-role', name: 'Allfather' }],
    ['aesir-role', { id: 'aesir-role', name: 'Aesir' }],
    ['global-captain-role', { id: 'global-captain-role', name: 'Captain' }],
  ]);
  const memberRoles = new Collection<string, any>([
    ['global-captain-role', roles.get('global-captain-role')],
    ['division-role', roles.get('division-role')],
  ]);
  const members = new Collection<string, any>([
    ['existing-captain', {
      id: 'existing-captain',
      roles: {
        cache: memberRoles,
        add: async (role: { id: string }) => {
          assignedRoles.push(role.id);
          memberRoles.set(role.id, role);
        },
        remove: async (role: { id: string }) => memberRoles.delete(role.id),
      },
    }],
  ]);
  const channels = new Collection<string, any>();
  channels.set(categoryId, {
    id: categoryId,
    name: 'Vanaheim',
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionOverwrites: { set: async () => undefined },
  });
  channels.set('scout-ops-category', {
    id: 'scout-ops-category',
    name: 'Scouting Operations',
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionOverwrites: { set: async () => undefined },
  });
  channels.set('scout-ops-channel', {
    id: 'scout-ops-channel',
    name: 'scout-ops',
    type: ChannelType.GuildText,
    parentId: 'scout-ops-category',
  });

  const observedLegacyNames = new Map([
    ['captain_chat', 'captain-chat'],
    ['announcements', 'vanaheim-announcements'],
    ['general', 'general'],
    ['tier_list', 'tier-list'],
    ['scheduling', 'scheduling'],
    ['match_reports', 'match-reports'],
    ['scout_signups', 'scout-signups'],
    ['scout_results', 'scout-results'],
    ['lobby', 'Vanaheim Lobby'],
  ]);

  for (const channelSpec of template.channels) {
    const id = `channel-${channelSpec.key}`;
    const legacyName = observedLegacyNames.get(channelSpec.key)!;
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
      setParent: async function (nextParentId: string) {
        moved.push([id, nextParentId]);
        this.parentId = nextParentId;
        return this;
      },
    });
  }
  channels.set('unmanaged-lobby-2', {
    id: 'unmanaged-lobby-2',
    name: 'Vanaheim Lobby 2',
    type: ChannelType.GuildVoice,
    parentId: categoryId,
  });

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
    members: { fetch: async () => members },
  } as unknown as Guild;

  try {
    setScoutOperationsChannel(db, 'guild-1', 'scout-ops-category', 'scout-ops-channel');
    insertManagedResource(db, {
      discordResourceId: 'captain-role',
      guildId: 'guild-1',
      resourceType: 'role',
      logicalKey: 'division:vanaheim:captain_role',
      scaffoldDomain: 'division',
    });
    insertManagedResource(db, {
      discordResourceId: 'deleted-prefixed-general',
      guildId: 'guild-1',
      resourceType: 'text_channel',
      logicalKey: divisionChannelLogicalKey('vanaheim', 'general', 'text_channel'),
      parentResourceId: categoryId,
      scaffoldDomain: 'division',
    });
    await provisionDivision(db, guild, 'vanaheim');
    assert.deepEqual(renamedRoles, [['captain-role', 'Vanaheim Captain']]);
    assert.deepEqual(assignedRoles, ['captain-role']);
    assert.deepEqual(moved, [
      ['channel-scout_signups', 'scout-ops-category'],
      ['channel-scout_results', 'scout-ops-category'],
    ]);
    assert.deepEqual(renamed, [
      ['channel-captain_chat', 'vanaheim-captain-chat'],
      ['channel-general', 'vanaheim-general'],
      ['channel-tier_list', 'vanaheim-tier-list'],
      ['channel-scheduling', 'vanaheim-scheduling'],
      ['channel-match_reports', 'vanaheim-match-reports'],
      ['channel-scout_signups', 'vanaheim-scout-signups'],
      ['channel-scout_results', 'vanaheim-scout-results'],
    ]);
    const generalRows = listManagedResourcesByDomain(db, 'guild-1', 'division')
      .filter((resource) => resource.logicalKey === divisionChannelLogicalKey('vanaheim', 'general', 'text_channel'));
    assert.deepEqual(generalRows.map((resource) => [resource.discordResourceId, resource.status]), [
      ['channel-general', 'active'],
      ['deleted-prefixed-general', 'obsolete'],
    ]);
    assert.equal(channels.get('unmanaged-lobby-2')?.name, 'Vanaheim Lobby 2');
    assert.equal(listManagedResourcesByDomain(db, 'guild-1', 'division')
      .some((resource) => resource.discordResourceId === 'unmanaged-lobby-2'), false);
    const signupRow = listManagedResourcesByDomain(db, 'guild-1', 'division')
      .find((resource) => resource.discordResourceId === 'channel-scout_signups')!;
    // Simulate a crash after Discord moved the channel but before the DB write.
    setManagedResourceParent(db, signupRow.id, categoryId);
    await provisionDivision(db, guild, 'vanaheim');
    assert.equal(listManagedResourcesByDomain(db, 'guild-1', 'division')
      .find((resource) => resource.id === signupRow.id)?.parentResourceId, 'scout-ops-category');
    assert.equal(moved.length, 2, 'retry must not move or recreate already-correct channels');
  } finally {
    closeDatabase(db);
  }
});
