import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutResultMarker, hasExactScoutMarker } from './scoutPublish.js';

test('published result posts have a setup-specific restart recovery marker', () => {
  assert.equal(scoutResultMarker(42), 'SCOUT-RESULT-42');
});

test('recovery cannot attach a different setup or version sharing a marker prefix', () => {
  assert.equal(hasExactScoutMarker('Roster\n\n`SCOUT-RESULT-10`', scoutResultMarker(1)), false);
  assert.equal(hasExactScoutMarker('Roster\n\n`SCOUT-RESULT-1`', scoutResultMarker(1)), true);
  assert.equal(hasExactScoutMarker('SCOUT-UPDATE-1-10', 'SCOUT-UPDATE-1-1'), false);
});
