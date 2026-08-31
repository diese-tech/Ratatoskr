import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidScoutTimezone } from './scoutConfig.js';

test('scout timezone accepts IANA zones and rejects arbitrary text', () => {
  assert.equal(isValidScoutTimezone('America/New_York'), true);
  assert.equal(isValidScoutTimezone('Europe/London'), true);
  assert.equal(isValidScoutTimezone('Eastern Time'), false);
  assert.equal(isValidScoutTimezone(''), false);
});
