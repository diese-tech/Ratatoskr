import assert from 'node:assert/strict';
import test from 'node:test';
import { renderScoutResult } from './scoutResults.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';

test('published scout result contains the two rosters and no score fields', () => {
  const slots = SCOUT_ROLES.flatMap((role) =>
    SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${role}-${index}` })),
  );
  const result = renderScoutResult({ divisionDisplayName: 'Vanaheim', startAt: 2_000_000_000 }, slots);
  assert.match(result, /Order/);
  assert.match(result, /Chaos/);
  assert.equal(result.includes('Score'), false);
  for (const slot of slots) assert.match(result, new RegExp(`<@${slot.userId}>`));
});
