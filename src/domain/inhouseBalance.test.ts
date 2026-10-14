import assert from 'node:assert/strict';
import test from 'node:test';
import { generateScoutWorkingRoster, type ScoutRosterSlot } from './scoutRoster.js';
import { balanceInhouseRoster } from './inhouseBalance.js';
import { SCOUT_ROLES } from './scoutRoles.js';

test('division balancing spreads the same signup pool without dropping players or changing play roles', () => {
  const signups = SCOUT_ROLES.flatMap((role, index) => [
    { userId: `upper-${index}`, role, createdAt: '2026-01-01' },
    { userId: `lower-${index}`, role, createdAt: '2026-01-02' },
  ]);
  const working = generateScoutWorkingRoster(signups);
  const divisions = new Map(signups.map(s => [s.userId, s.userId.startsWith('upper') ? 'vanaheim' : 'svartalfheim']));
  const balanced = balanceInhouseRoster(working.slots, divisions);
  assert.equal(balanced.length, 10);
  assert.deepEqual(balanced.map(s => `${s.userId}:${s.role}`).sort(), working.slots.map(s => `${s.userId}:${s.role}`).sort());
  const upperOnOrder = balanced.filter(s => s.team === 'team_one' && divisions.get(s.userId) === 'vanaheim').length;
  assert.ok(upperOnOrder === 2 || upperOnOrder === 3);
});

test('manual seats and unknown or lopsided divisions remain playable with no balance threshold', () => {
  const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role, i) => [
    { team: 'team_one', role, userId: `a${i}` }, { team: 'team_two', role, userId: `b${i}` },
  ]);
  const fixed = slots.slice(0, 2);
  const hints = new Map(slots.slice(0, 3).map(s => [s.userId, 'vanaheim']));
  const result = balanceInhouseRoster(slots, hints, fixed);
  assert.equal(result.length, 10);
  for (const slot of fixed) assert.deepEqual(result.find(s => s.userId === slot.userId), slot);
  assert.deepEqual(balanceInhouseRoster(slots, new Map()), slots);
});
