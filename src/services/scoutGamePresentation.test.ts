import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoutRosterChangeFailure } from './scoutGamePresentation.js';

test('rejected roster edits explain the next action without displaying internal outcomes', () => {
  assert.match(scoutRosterChangeFailure('duplicate'), /already on a team.*Choose someone else/);
  assert.match(scoutRosterChangeFailure('occupied'), /already filled.*Choose another spot/);
  assert.match(scoutRosterChangeFailure('stale'), /changed.*latest roster controls/);
  assert.match(scoutRosterChangeFailure('off_role_confirmation'), /did not sign up.*confirm/);
  assert.match(scoutRosterChangeFailure('ineligible'), /signup and access/);
  for (const outcome of ['stale', 'duplicate', 'occupied', 'ineligible', 'off_role_confirmation', 'PRIVATE_INTERNAL_ERROR']) {
    const reply = scoutRosterChangeFailure(outcome);
    assert.ok(reply.startsWith('No player change was made.'));
    assert.ok(!reply.includes(outcome));
  }
});
