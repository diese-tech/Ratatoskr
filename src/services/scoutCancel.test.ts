import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'discord.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import {
  cancelScoutSetupIfVersion,
  createScoutSetup,
  getScoutSetupById,
  setScoutSetupSignupMessage,
} from '../db/repositories/scoutSetups.js';
import { reconcileCancelledScoutSignupPost, scoutCancelButtonRow } from './scoutCancel.js';
import { scoutReviewButtonRow } from './scoutReview.js';

test('cancellation retry and Scout Ops controls remain setup-specific', () => {
  const retryControls = scoutCancelButtonRow(42, 0).toJSON().components;
  assert.deepEqual(retryControls.map((component) => 'custom_id' in component ? component.custom_id : undefined), ['scout:cancel:42:0']);

  const rosterControls = scoutReviewButtonRow(42).toJSON().components;
  assert.deepEqual(rosterControls.map((component) => 'custom_id' in component ? component.custom_id : undefined), ['scout:review:42', 'scout:cancel:42:0']);
});

test('a cancelled setup stays pending until its public post and reactions are reconciled', async () => {
  const db = openDatabase(':memory:');
  try {
    const division = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'division-role',
      managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'division-category',
    });
    const setup = createScoutSetup(db, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'scout-ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' },
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'signup-message');
    assert.equal(cancelScoutSetupIfVersion(db, setup.id, 0), 'cancelled');
    let edited = false;
    let reactionsRemoved = false;
    const signupMessage = {
      edit: async () => { edited = true; },
      reactions: { removeAll: async () => { reactionsRemoved = true; } },
    };
    const signupChannel = {
      isTextBased: () => true,
      messages: { fetch: async () => signupMessage },
    };
    const client = {
      channels: { fetch: async (id: string) => id === 'signups' ? signupChannel : undefined },
    } as unknown as Client;

    const cancelled = getScoutSetupById(db, setup.id)!;
    assert.equal(await reconcileCancelledScoutSignupPost(client, db, cancelled), undefined);
    assert.equal(edited, true);
    assert.equal(reactionsRemoved, true);
    assert.equal(getScoutSetupById(db, setup.id)?.signupPostReconciled, true);
  } finally {
    closeDatabase(db);
  }
});
