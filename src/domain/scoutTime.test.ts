import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScoutStartTime } from './scoutTime.js';

test('scout start time parses future coordinator language in the configured timezone', () => {
  const now = new Date('2026-08-30T16:00:00Z'); // noon in New York
  const parsed = parseScoutStartTime('tomorrow at 8pm', 'America/New_York', now);
  assert.deepEqual(parsed, { ok: true, startAt: 1_788_220_800 });
});

test('scout start time rejects text that resolves into the past', () => {
  const now = new Date('2026-08-30T16:00:00Z');
  const parsed = parseScoutStartTime('today at 8am', 'America/New_York', now);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'in_past');
});
