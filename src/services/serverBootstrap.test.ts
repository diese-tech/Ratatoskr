import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { test } from 'node:test';
import type { ManagedResource } from '../db/types.js';
import {
  classifyMatch,
  currentServerLogicalKeys,
  detectObsoleteManagedResources,
  resolveChannelPermissionOverwrites,
  serverCategoryLogicalKey,
  serverChannelLogicalKey,
  serverRoleLogicalKey,
  type CandidateResource,
} from './serverBootstrap.js';

const EVERYONE_ID = 'everyone-role-id';
const roleIds: Record<string, string> = { Æsir: 'aesir-id', Allfather: 'allfather-id', Valkyries: 'valkyries-id' };
const resolveRoleId = (name: string) => roleIds[name];

function managedResource(overrides: Partial<ManagedResource>): ManagedResource {
  return {
    id: 1,
    discordResourceId: 'discord-id',
    guildId: 'guild-1',
    resourceType: 'text_channel',
    logicalKey: 'server:example:channel',
    parentResourceId: null,
    scaffoldDomain: 'server',
    scaffoldVersion: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('classifyMatch: no same-named candidate is "none"', () => {
  const result = classifyMatch([], { name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' });
  assert.equal(result.outcome, 'none');
});

test('classifyMatch: exactly one candidate matching name/kind/parent is "exact"', () => {
  const candidates: CandidateResource[] = [
    { discordId: 'chan-1', name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' },
  ];
  const result = classifyMatch(candidates, { name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' });
  assert.equal(result.outcome, 'exact');
  assert.equal(result.outcome === 'exact' && result.candidate.discordId, 'chan-1');
});

test('classifyMatch: same name but wrong type is "ambiguous"', () => {
  const candidates: CandidateResource[] = [
    { discordId: 'chan-1', name: 'sign-ups', kind: 'voice_channel', parentId: 'category-1' },
  ];
  const result = classifyMatch(candidates, { name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' });
  assert.equal(result.outcome, 'ambiguous');
});

test('classifyMatch: same name but wrong parent category is "ambiguous"', () => {
  const candidates: CandidateResource[] = [
    { discordId: 'chan-1', name: 'sign-ups', kind: 'text_channel', parentId: 'some-other-category' },
  ];
  const result = classifyMatch(candidates, { name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' });
  assert.equal(result.outcome, 'ambiguous');
});

test('classifyMatch: multiple same-named candidates is "ambiguous" even if one matches exactly', () => {
  const candidates: CandidateResource[] = [
    { discordId: 'chan-1', name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' },
    { discordId: 'chan-2', name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' },
  ];
  const result = classifyMatch(candidates, { name: 'sign-ups', kind: 'text_channel', parentId: 'category-1' });
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.outcome === 'ambiguous' && result.candidates.length, 2);
});

test('classifyMatch: a resource with no template slot at all (e.g. League Players) never appears as ambiguous or exact for an unrelated slot', () => {
  const candidates: CandidateResource[] = [
    { discordId: 'cat-legacy', name: 'League Players', kind: 'category', parentId: null },
  ];
  const result = classifyMatch(candidates, { name: 'League Information', kind: 'category', parentId: null });
  assert.equal(result.outcome, 'none');
});

test('detectObsoleteManagedResources: only active resources absent from the current template are obsolete', () => {
  const stillCanonical = managedResource({ id: 1, logicalKey: 'server:welcome:category', status: 'active' });
  const obsolete = managedResource({ id: 2, logicalKey: 'server:league-players:category', status: 'active' });
  const alreadyObsolete = managedResource({ id: 3, logicalKey: 'server:old-thing:category', status: 'obsolete' });

  const currentKeys = new Set(['server:welcome:category']);
  const result = detectObsoleteManagedResources([stillCanonical, obsolete, alreadyObsolete], currentKeys);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

test('detectObsoleteManagedResources: an empty managed_resources set (first run) never produces obsolete candidates', () => {
  const result = detectObsoleteManagedResources([], new Set(['server:welcome:category']));
  assert.deepEqual(result, []);
});

test('logical key builders are stable and slot-shaped', () => {
  assert.equal(serverRoleLogicalKey('Allfather'), 'server:allfather:role');
  assert.equal(serverCategoryLogicalKey('League Information'), 'server:league-information:category');
  assert.equal(serverChannelLogicalKey('League Information', 'sign-ups'), 'server:league-information:sign-ups:channel');
});

test('currentServerLogicalKeys reflects every role/category/channel in the template', () => {
  const structure = {
    roles: [{ name: 'Allfather' }],
    categories: [
      {
        name: 'Welcome',
        channels: [{ name: 'welcome', type: 'text' as const }],
      },
    ],
  };

  const keys = currentServerLogicalKeys(structure);
  assert.ok(keys.has('server:allfather:role'));
  assert.ok(keys.has('server:welcome:category'));
  assert.ok(keys.has('server:welcome:welcome:channel'));
  assert.equal(keys.size, 3);
});

test('resolveChannelPermissionOverwrites: no access and no readOnly produces no overwrites', () => {
  const result = resolveChannelPermissionOverwrites(EVERYONE_ID, resolveRoleId, ['Æsir'], {});
  assert.equal(result, undefined);
});

test('resolveChannelPermissionOverwrites: readOnly denies SendMessages/CreatePublicThreads to @everyone and allows staff', () => {
  const result = resolveChannelPermissionOverwrites(EVERYONE_ID, resolveRoleId, ['Æsir', 'Allfather'], { readOnly: true });
  assert.ok(result);

  const everyone = result!.find((entry) => entry.id === EVERYONE_ID);
  assert.deepEqual(everyone?.deny.sort(), [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads].sort());
  assert.deepEqual(everyone?.allow, []);

  const staff = result!.find((entry) => entry.id === roleIds.Æsir);
  assert.deepEqual(staff?.allow.sort(), [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads].sort());
});

test('resolveChannelPermissionOverwrites: access alone still denies/allows only ViewChannel, unchanged from before readOnly existed', () => {
  const result = resolveChannelPermissionOverwrites(EVERYONE_ID, resolveRoleId, ['Æsir'], { access: ['Allfather'] });
  assert.ok(result);

  const everyone = result!.find((entry) => entry.id === EVERYONE_ID);
  assert.deepEqual(everyone?.deny, [PermissionFlagsBits.ViewChannel]);

  const allowed = result!.find((entry) => entry.id === roleIds.Allfather);
  assert.deepEqual(allowed?.allow, [PermissionFlagsBits.ViewChannel]);
});

test('resolveChannelPermissionOverwrites: access + readOnly on the same role id merge into one overwrite entry, not two', () => {
  // Allfather is both granted view access and is staff (can post) here --
  // this must land as a single entry for allfather-id with both allows,
  // never two separate entries for the same role id.
  const result = resolveChannelPermissionOverwrites(EVERYONE_ID, resolveRoleId, ['Allfather'], {
    access: ['Allfather'],
    readOnly: true,
  });
  assert.ok(result);

  const allfatherEntries = result!.filter((entry) => entry.id === roleIds.Allfather);
  assert.equal(allfatherEntries.length, 1, 'must merge into a single overwrite entry per id');
  assert.deepEqual(
    allfatherEntries[0].allow.sort(),
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads].sort(),
  );

  const everyoneEntries = result!.filter((entry) => entry.id === EVERYONE_ID);
  assert.equal(everyoneEntries.length, 1, 'must merge @everyone into a single overwrite entry too');
  assert.deepEqual(
    everyoneEntries[0].deny.sort(),
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads].sort(),
  );
});

test('resolveChannelPermissionOverwrites: missing access role throws a clear error', () => {
  assert.throws(() => {
    resolveChannelPermissionOverwrites(EVERYONE_ID, () => undefined, [], { access: ['Nonexistent Role'] });
  }, /Missing configured role: Nonexistent Role/);
});
