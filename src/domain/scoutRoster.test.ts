import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScoutRoster } from './scoutRoster.js';
import { SCOUT_ROLES } from './scoutRoles.js';

const signup = (userId: string, role: (typeof SCOUT_ROLES)[number], order: number) => ({
  userId,
  role,
  createdAt: `2026-01-01T00:00:${String(order).padStart(2, '0')}.000Z`,
});

test('scout roster requires a compatible ten-player matching, not raw reaction counts', () => {
  const signups = [
    signup('a', 'solo', 1), signup('a', 'jungle', 1),
    signup('b', 'solo', 2), signup('b', 'jungle', 2),
    signup('c', 'mid', 3), signup('d', 'mid', 4),
    signup('e', 'support', 5), signup('f', 'support', 6),
    signup('g', 'carry', 7), signup('h', 'carry', 8),
    signup('i', 'mid', 9), signup('j', 'support', 10),
  ];
  assert.equal(generateScoutRoster(signups).feasible, false);
});

test('scout roster fills each role once on both teams with ten unique players', () => {
  const signups = SCOUT_ROLES.flatMap((role, roleIndex) => [
    signup(`${role}-1`, role, roleIndex * 2),
    signup(`${role}-2`, role, roleIndex * 2 + 1),
  ]);
  const result = generateScoutRoster(signups);
  assert.equal(result.feasible, true);
  assert.equal(result.slots.length, 10);
  assert.equal(new Set(result.slots.map((slot) => slot.userId)).size, 10);
  for (const role of SCOUT_ROLES) {
    assert.equal(result.slots.filter((slot) => slot.role === role).length, 2);
  }
});
