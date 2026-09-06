import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPersistedScoutSignupPost, scoutSignupEmojiIds } from './scoutCreate.js';
import type { ScoutSetup } from '../db/index.js';

const required = {
  solo: 'solo',
  jungle: 'jungle',
  mid: 'mid',
  support: 'support',
  carry: 'carry',
};

test('new signup posts seed optional Fill last and omit it when skipped', () => {
  assert.deepEqual(scoutSignupEmojiIds({ ...required, fill: 'fill' }), [
    'solo',
    'jungle',
    'mid',
    'support',
    'carry',
    'fill',
  ]);
  assert.deepEqual(scoutSignupEmojiIds({ ...required, fill: null }), [
    'solo',
    'jungle',
    'mid',
    'support',
    'carry',
  ]);
});

test('signup post content does not expose its restart correlation identifier', () => {
  const content = renderPersistedScoutSignupPost({
    id: 42,
    divisionDisplayName: 'Vanaheim',
    divisionRoleId: 'division-role',
    startAt: 2_000_000_000,
    roleLimit: 2,
    emojiByRole: required,
  } as ScoutSetup);
  assert.doesNotMatch(content, /SCOUT-|scout:signup/);
});
