import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DivisionRecord, ManagedResource } from '../db/types.js';
import { resolveScoutChannelGroup, resolveScoutChannelScope } from './scoutChannels.js';

function division(overrides: Partial<DivisionRecord> = {}): DivisionRecord {
  return {
    id: 1,
    guildId: 'guild-1',
    divisionKey: 'vanaheim',
    displayName: 'Vanaheim',
    seasonId: null,
    roleId: 'vanaheim-role',
    captainAccessRoleId: 'vanaheim-captain-access',
    categoryId: 'vanaheim-category',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function resource(overrides: Partial<ManagedResource> = {}): ManagedResource {
  return {
    id: 1,
    discordResourceId: 'legacy-unprefixed-signups',
    guildId: 'guild-1',
    resourceType: 'text_channel',
    logicalKey: 'division:vanaheim:channel:scout_signups:text_channel',
    parentResourceId: 'vanaheim-category',
    scaffoldDomain: 'division',
    scaffoldVersion: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('resolveScoutChannelScope resolves a live managed legacy channel by stored ID, not visible name', () => {
  const scope = resolveScoutChannelScope({
    guildId: 'guild-1',
    channelId: 'legacy-unprefixed-signups',
    divisions: [division()],
    managedResources: [resource()],
    liveChannels: new Map([
      ['legacy-unprefixed-signups', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
    ]),
  });

  assert.deepEqual(scope, {
    divisionId: 1,
    divisionKey: 'vanaheim',
    purpose: 'signups',
    channelId: 'legacy-unprefixed-signups',
  });
});

test('resolveScoutChannelScope identifies a managed division results channel by its stable logical key', () => {
  const scope = resolveScoutChannelScope({
    guildId: 'guild-1',
    channelId: 'results-channel',
    divisions: [division()],
    managedResources: [
      resource({
        discordResourceId: 'results-channel',
        logicalKey: 'division:vanaheim:channel:scout_results:text_channel',
      }),
    ],
    liveChannels: new Map([
      ['results-channel', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
    ]),
  });

  assert.equal(scope?.purpose, 'results');
  assert.equal(scope?.divisionKey, 'vanaheim');
});

test('resolveScoutChannelGroup returns the complete live signup/results pair for the source division', () => {
  const group = resolveScoutChannelGroup({
    guildId: 'guild-1',
    sourceChannelId: 'legacy-unprefixed-signups',
    divisions: [division()],
    managedResources: [
      resource(),
      resource({
        id: 2,
        discordResourceId: 'legacy-unprefixed-results',
        logicalKey: 'division:vanaheim:channel:scout_results:text_channel',
      }),
    ],
    liveChannels: new Map([
      ['legacy-unprefixed-signups', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
      ['legacy-unprefixed-results', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
    ]),
  });

  assert.deepEqual(group, {
    divisionId: 1,
    divisionKey: 'vanaheim',
    signupChannelId: 'legacy-unprefixed-signups',
    resultsChannelId: 'legacy-unprefixed-results',
  });
});

test('resolveScoutChannelGroup rejects a results channel recorded under the wrong division category', () => {
  const group = resolveScoutChannelGroup({
    guildId: 'guild-1',
    sourceChannelId: 'legacy-unprefixed-signups',
    divisions: [division()],
    managedResources: [
      resource(),
      resource({
        id: 2,
        discordResourceId: 'wrong-parent-results',
        logicalKey: 'division:vanaheim:channel:scout_results:text_channel',
        parentResourceId: 'alfheim-category',
      }),
    ],
    liveChannels: new Map([
      ['legacy-unprefixed-signups', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
      ['wrong-parent-results', { resourceType: 'text_channel' as const, parentId: 'alfheim-category' }],
    ]),
  });

  assert.equal(group, undefined);
});

test('resolveScoutChannelScope fails closed for archived divisions, obsolete resources, and missing Discord channels', () => {
  const base = {
    guildId: 'guild-1',
    channelId: 'legacy-unprefixed-signups',
    liveChannels: new Map([
      ['legacy-unprefixed-signups', { resourceType: 'text_channel' as const, parentId: 'vanaheim-category' }],
    ]),
  };

  assert.equal(
    resolveScoutChannelScope({ ...base, divisions: [division({ status: 'archived' })], managedResources: [resource()] }),
    undefined,
  );
  assert.equal(
    resolveScoutChannelScope({
      ...base,
      divisions: [division()],
      managedResources: [resource({ status: 'obsolete' })],
    }),
    undefined,
  );
  assert.equal(
    resolveScoutChannelScope({ ...base, divisions: [division()], managedResources: [resource()], liveChannels: new Map() }),
    undefined,
  );
});
