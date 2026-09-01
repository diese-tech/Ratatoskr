import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import {
  ensureScoutConfig,
  getScoutConfig,
  missingScoutConfigFields,
  setScoutAuthorizedRoleIds,
  setScoutEmojiByRole,
  setScoutOperationsChannel,
  setScoutTimezone,
} from './scoutConfig.js';
import { createScoutSetup, getScoutSetupById, setScoutSetupSignupMessage } from './scoutSetups.js';

test('ensureScoutConfig creates one guild config with safe defaults and returns it through the repository', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(getScoutConfig(db, 'guild-1'), undefined);

    const created = ensureScoutConfig(db, 'guild-1');
    assert.equal(created.guildId, 'guild-1');
    assert.equal(created.timezone, 'America/New_York');
    assert.deepEqual(created.authorizedRoleIds, []);
    assert.equal(created.operationsCategoryId, null);
    assert.equal(created.operationsChannelId, null);
    assert.deepEqual(created.emojiByRole, {
      solo: null,
      jungle: null,
      mid: null,
      support: null,
      carry: null,
      fill: null,
    });

    assert.deepEqual(getScoutConfig(db, 'guild-1'), created);
  } finally {
    closeDatabase(db);
  }
});

test('setScoutOperationsChannel binds the manually created operations channel and its parent category by ID', () => {
  const db = openDatabase(':memory:');
  try {
    const updated = setScoutOperationsChannel(db, 'guild-1', 'scout-ops-category', 'scout-ops-channel');
    assert.equal(updated.operationsCategoryId, 'scout-ops-category');
    assert.equal(updated.operationsChannelId, 'scout-ops-channel');
    assert.deepEqual(getScoutConfig(db, 'guild-1'), updated);
  } finally {
    closeDatabase(db);
  }
});

test('binding Scout Ops routes every active setup to the current operations channel', () => {
  const db = openDatabase(':memory:');
  try {
    const division = upsertDivision(db, {
      guildId: 'guild-1', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'division-role',
      categoryId: 'division-category', managerRoleId: 'manager-role', captainRoleId: 'captain-role',
    });
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole: {
        solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry',
      }, startAt: 2_000_000_000, roleLimit: 2,
    });
    const posting = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-2', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole: {
        solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry',
      }, startAt: 2_000_000_060, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'signup-message');

    setScoutOperationsChannel(db, 'guild-1', 'scout-category', 'scout-ops');

    assert.equal(getScoutSetupById(db, setup.id)?.operationsChannelId, 'scout-ops');
    assert.equal(getScoutSetupById(db, posting.id)?.operationsChannelId, 'scout-ops');
    setScoutOperationsChannel(db, 'guild-1', 'new-scout-category', 'new-scout-ops');
    assert.equal(getScoutSetupById(db, setup.id)?.operationsChannelId, 'new-scout-ops');
    assert.equal(getScoutSetupById(db, posting.id)?.operationsChannelId, 'new-scout-ops');
  } finally {
    closeDatabase(db);
  }
});

test('setScoutAuthorizedRoleIds persists the complete selected role set', () => {
  const db = openDatabase(':memory:');
  try {
    setScoutAuthorizedRoleIds(db, 'guild-1', ['role-a', 'role-b']);
    assert.deepEqual(getScoutConfig(db, 'guild-1')?.authorizedRoleIds, ['role-a', 'role-b']);

    setScoutAuthorizedRoleIds(db, 'guild-1', ['role-c']);
    assert.deepEqual(getScoutConfig(db, 'guild-1')?.authorizedRoleIds, ['role-c']);
  } finally {
    closeDatabase(db);
  }
});

test('missingScoutConfigFields names every role emoji until all five are bound', () => {
  const db = openDatabase(':memory:');
  try {
    const config = ensureScoutConfig(db, 'guild-1');
    assert.deepEqual(missingScoutConfigFields(config), [
      'Solo emoji',
      'Jungle emoji',
      'Mid emoji',
      'Support emoji',
      'Carry emoji',
    ]);

    const complete = setScoutEmojiByRole(db, 'guild-1', {
      solo: 'emoji-solo',
      jungle: 'emoji-jungle',
      mid: 'emoji-mid',
      support: 'emoji-support',
      carry: 'emoji-carry',
    });
    assert.deepEqual(missingScoutConfigFields(complete), []);
  } finally {
    closeDatabase(db);
  }
});

test('setScoutTimezone persists the guild timezone independently of other config', () => {
  const db = openDatabase(':memory:');
  try {
    setScoutAuthorizedRoleIds(db, 'guild-1', ['role-a']);
    const updated = setScoutTimezone(db, 'guild-1', 'America/Chicago');
    assert.equal(updated.timezone, 'America/Chicago');
    assert.deepEqual(updated.authorizedRoleIds, ['role-a']);
  } finally {
    closeDatabase(db);
  }
});

test('Fill emoji is optional and can be configured or cleared independently', () => {
  const db = openDatabase(':memory:');
  try {
    const standard = {
      solo: 'emoji-solo',
      jungle: 'emoji-jungle',
      mid: 'emoji-mid',
      support: 'emoji-support',
      carry: 'emoji-carry',
    };
    assert.equal(setScoutEmojiByRole(db, 'guild-1', standard).emojiByRole.fill, null);
    assert.equal(setScoutEmojiByRole(db, 'guild-1', { ...standard, fill: 'emoji-fill' }).emojiByRole.fill, 'emoji-fill');
    assert.equal(setScoutEmojiByRole(db, 'guild-1', { ...standard, fill: null }).emojiByRole.fill, null);
  } finally {
    closeDatabase(db);
  }
});
