import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutRoleForEmoji } from './scoutSignups.js';

test('signup reaction role resolution uses the setup emoji snapshot', () => {
  const snapshot = {
    solo: 'old-solo',
    jungle: 'old-jungle',
    mid: 'old-mid',
    support: 'old-support',
    carry: 'old-carry',
    fill: 'old-fill',
  } as const;

  assert.equal(scoutRoleForEmoji(snapshot, 'old-mid'), 'mid');
  assert.equal(scoutRoleForEmoji(snapshot, 'old-fill'), 'fill');
  assert.equal(scoutRoleForEmoji(snapshot, 'new-mid'), undefined);
  assert.equal(scoutRoleForEmoji(snapshot, null), undefined);
});
