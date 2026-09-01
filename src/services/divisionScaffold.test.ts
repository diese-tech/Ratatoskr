import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoDuplicateKeys,
  divisionCaptainRoleLogicalKey,
  divisionCategoryLogicalKey,
  divisionChannelLogicalKey,
  divisionManagerRoleLogicalKey,
  divisionRoleLogicalKey,
  findUnmanagedCategoryChildren,
  resourcesForDivision,
} from './divisionScaffold.js';

test('logical key builders consume the authored division/channel key, not a display name', () => {
  assert.equal(divisionRoleLogicalKey('vanaheim'), 'division:vanaheim:role');
  assert.equal(divisionManagerRoleLogicalKey('vanaheim'), 'division:vanaheim:manager_role');
  assert.equal(divisionCaptainRoleLogicalKey('vanaheim'), 'division:vanaheim:captain_role');
  assert.equal(divisionCategoryLogicalKey('vanaheim'), 'division:vanaheim:category');
  assert.equal(divisionChannelLogicalKey('vanaheim', 'general', 'text_channel'), 'division:vanaheim:channel:general:text_channel');
});

test('divisionChannelLogicalKey: kind stays a required, separate segment even if a channel key were reused for both text and voice', () => {
  const textKey = divisionChannelLogicalKey('vanaheim', 'general', 'text_channel');
  const voiceKey = divisionChannelLogicalKey('vanaheim', 'general', 'voice_channel');
  assert.notEqual(textKey, voiceKey);
});

test('assertNoDuplicateKeys throws a clear error naming the collided key', () => {
  assert.throws(
    () => assertNoDuplicateKeys('division', [{ key: 'vanaheim' }, { key: 'alfheim' }, { key: 'vanaheim' }]),
    /Duplicate division key\(s\): vanaheim/,
  );
});

test('assertNoDuplicateKeys does not throw when every key is unique', () => {
  assert.doesNotThrow(() => assertNoDuplicateKeys('division', [{ key: 'vanaheim' }, { key: 'alfheim' }]));
});

test('resourcesForDivision: filters a mixed-domain resource list down to exactly one division, by logical key prefix', () => {
  const resources = [
    { logicalKey: 'division:vanaheim:role', discordResourceId: 'r1', resourceType: 'role' as const },
    { logicalKey: 'division:vanaheim:category', discordResourceId: 'r2', resourceType: 'category' as const },
    { logicalKey: 'division:alfheim:role', discordResourceId: 'r3', resourceType: 'role' as const },
    { logicalKey: 'server:role:allfather', discordResourceId: 'r4', resourceType: 'role' as const },
  ];

  const vanaheimResources = resourcesForDivision(resources, 'vanaheim');
  assert.deepEqual(
    vanaheimResources.map((r) => r.discordResourceId),
    ['r1', 'r2'],
  );
});

test('resourcesForDivision: a division key that is a textual prefix of another division key never leaks across them', () => {
  // 'vanaheim' is a prefix of 'vanaheim2' -- the trailing ':' in the
  // "division:<key>:" prefix match is what prevents this from being treated
  // as a match; without it, filtering by 'vanaheim' would also catch every
  // resource actually belonging to 'vanaheim2'.
  const resources = [
    { logicalKey: 'division:vanaheim:role', discordResourceId: 'r1', resourceType: 'role' as const },
    { logicalKey: 'division:vanaheim2:role', discordResourceId: 'r2', resourceType: 'role' as const },
  ];

  const vanaheimResources = resourcesForDivision(resources, 'vanaheim');
  assert.deepEqual(
    vanaheimResources.map((r) => r.discordResourceId),
    ['r1'],
  );
});

test('findUnmanagedCategoryChildren: returns exactly the child ids with no managed row -- the archive/delete safety split', () => {
  // #31 required change: /division delete may only ever resolve its target
  // set from persisted managed_resources rows, never from
  // category.children.cache directly. Given a category with 3 managed
  // channels and 1 channel a human added directly in Discord, this must
  // name exactly that one unmanaged channel so delete can block on it.
  const categoryChildIds = ['managed-1', 'managed-2', 'managed-3', 'human-added-channel'];
  const managedChannelDiscordIds = ['managed-1', 'managed-2', 'managed-3'];

  const unmanaged = findUnmanagedCategoryChildren(categoryChildIds, managedChannelDiscordIds);
  assert.deepEqual(unmanaged, ['human-added-channel']);
});

test('findUnmanagedCategoryChildren: an empty result means delete is safe to proceed', () => {
  const unmanaged = findUnmanagedCategoryChildren(['managed-1', 'managed-2'], ['managed-1', 'managed-2']);
  assert.deepEqual(unmanaged, []);
});
