import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutSignupEmojiIds } from './scoutCreate.js';

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
