import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScoutRoster } from './scoutRoster.js';
import { SCOUT_ROLES, type ScoutSignupRole } from './scoutRoles.js';

const signup = (userId: string, role: ScoutSignupRole, order: number) => ({
  userId,
  role,
  createdAt: `2026-01-01T00:00:${String(order).padStart(2, '0')}.000Z`,
});

test('a Fill signup can occupy a missing standard role without creating a Fill roster slot', () => {
  const signups = SCOUT_ROLES.flatMap((role, roleIndex) =>
    role === 'carry'
      ? [signup('carry-1', role, roleIndex * 2), signup('fill-1', 'fill', roleIndex * 2 + 1)]
      : [signup(`${role}-1`, role, roleIndex * 2), signup(`${role}-2`, role, roleIndex * 2 + 1)],
  );

  const result = generateScoutRoster(signups);

  assert.equal(result.feasible, true);
  assert.equal(result.slots.find((slot) => slot.userId === 'fill-1')?.role, 'carry');
  assert.equal(result.slots.some((slot) => (slot.role as string) === 'fill'), false);
});

test('explicit role signups are rostered before Fill-only alternates', () => {
  const signups = [
    signup('fill-early-1', 'fill', 1),
    signup('fill-early-2', 'fill', 2),
    ...SCOUT_ROLES.flatMap((role, roleIndex) => [
      signup(`${role}-explicit-1`, role, roleIndex * 2 + 3),
      signup(`${role}-explicit-2`, role, roleIndex * 2 + 4),
    ]),
  ];

  const result = generateScoutRoster(signups);

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.slots.filter((slot) => slot.role === 'carry').map((slot) => slot.userId).sort(),
    ['carry-explicit-1', 'carry-explicit-2'],
  );
  assert.equal(result.slots.some((slot) => slot.userId.startsWith('fill-early')), false);
});

test('shuffle still prefers explicit role signups over Fill-only alternates', () => {
  const signups = [
    signup('fill-early-1', 'fill', 1),
    signup('fill-early-2', 'fill', 2),
    ...SCOUT_ROLES.flatMap((role, roleIndex) => [
      signup(`${role}-explicit-1`, role, roleIndex * 2 + 3),
      signup(`${role}-explicit-2`, role, roleIndex * 2 + 4),
    ]),
  ];

  const result = generateScoutRoster(signups, { mode: 'shuffle', random: () => 0.999 });

  assert.equal(result.feasible, true);
  assert.equal(result.slots.some((slot) => slot.userId.startsWith('fill-early')), false);
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

test('two-game generation globally fills twenty unique standard-role slots', () => {
  const signups = SCOUT_ROLES.flatMap((role, roleIndex) =>
    Array.from({ length: 4 }, (_, index) => signup(`${role}-${index}`, role, roleIndex * 4 + index)),
  );
  const result = generateScoutRoster(signups, { gameCount: 2 });
  assert.equal(result.feasible, true);
  assert.equal(result.slots.length, 20);
  assert.equal(new Set(result.slots.map((slot) => slot.userId)).size, 20);
  assert.equal(result.slots.filter((slot) => slot.gameNumber === 1).length, 10);
  assert.equal(result.slots.filter((slot) => slot.gameNumber === 2).length, 10);
});
