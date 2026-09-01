import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutResultMarker } from './scoutPublish.js';

test('published result posts have a setup-specific restart recovery marker', () => {
  assert.equal(scoutResultMarker(42), 'SCOUT-RESULT-42');
});
