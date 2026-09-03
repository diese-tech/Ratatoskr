import assert from 'node:assert/strict';
import test from 'node:test';
import { scoutReadinessSnapshot, renderScoutReadiness } from './scoutReadiness.js';
import { SCOUT_ROLES } from './scoutRoles.js';

const signup = (userId: string, role: any) => ({ userId, role, createdAt: '2026-09-01' });
test('readiness counts unique players and uncapped role overflow separately', () => {
  const snapshot = scoutReadinessSnapshot([
    ...[1, 2, 3, 4].map((id) => signup(String(id), 'solo')),
    signup('1', 'mid'), signup('2', 'fill'), signup('2', 'fill'),
  ], 1);
  assert.equal(snapshot.players, 4);
  assert.equal(snapshot.roles[0]?.count, 4);
  assert.equal(snapshot.fill, 1);
  assert.match(renderScoutReadiness(snapshot), /Solo \*\*4\/2\*\*/);
  assert.equal(scoutReadinessSnapshot([], 1).players, 0);
});
test('Fill covers shortages without double counting and matching resolves overlap', () => {
  const fillRoster = Array.from({ length: 10 }, (_, i) => signup(String(i), 'fill'));
  const fillSnapshot = scoutReadinessSnapshot(fillRoster, 1);
  assert.equal(fillSnapshot.feasible, true);
  assert.ok(!renderScoutReadiness(fillSnapshot).includes('Waiting on'));
  const overlap = [...SCOUT_ROLES.flatMap((role) => [signup('flex1', role), signup('flex2', role)]),
    ...Array.from({ length: 8 }, (_, i) => signup(`solo${i}`, 'solo'))];
  assert.equal(scoutReadinessSnapshot(overlap, 1).feasible, false);
  assert.match(renderScoutReadiness(scoutReadinessSnapshot(overlap, 1)), /Role overlap/);
});
test('two-game requirements and eligible unseated participants reflect current slots', () => {
  const signups = Array.from({ length: 23 }, (_, i) => signup(String(i), 'fill'));
  const slots = SCOUT_ROLES.flatMap((role, index) => [0, 1, 2, 3].map((i) => ({
    gameNumber: Math.floor(i / 2) + 1, team: (i % 2 ? 'team_two' : 'team_one') as 'team_one' | 'team_two', role, userId: String(index * 4 + i),
  })));
  const snapshot = scoutReadinessSnapshot(signups, 2, slots, 1);
  assert.equal(snapshot.requiredPlayers, 20);
  assert.equal(snapshot.requiredPerRole, 4);
  assert.equal(snapshot.overflow, 3);
  assert.match(renderScoutReadiness(snapshot), /draft needs attention/);
  assert.match(renderScoutReadiness(snapshot, true), /Historical signups/);
  assert.ok(!renderScoutReadiness(snapshot, true).includes('can be formed'));
});
