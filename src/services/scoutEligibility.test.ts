import assert from 'node:assert/strict';
import test from 'node:test';
import { isScoutUserEligible } from './scoutEligibility.js';

test('an optional setup role restricts roster eligibility using current member roles', () => {
  assert.equal(isScoutUserEligible(['silver'], null), true);
  assert.equal(isScoutUserEligible(['silver'], 'silver'), true);
  assert.equal(isScoutUserEligible(['masters'], 'silver'), false);
});
