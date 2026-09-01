import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prioritizeObservedScoutSignups,
  scoutRoleForEmoji,
  selectReconciledScoutSignups,
} from './scoutSignups.js';

test('signup reaction role resolution uses the setup emoji snapshot', () => {
  const snapshot = {
    solo: 'old-solo',
    jungle: 'old-jungle',
    mid: 'old-mid',
    support: 'old-support',
    carry: 'old-carry',
    fill: 'old-fill',
  } as const;

  assert.equal(scoutRoleForEmoji(snapshot, 'old-mid'), 'mid');
  assert.equal(scoutRoleForEmoji(snapshot, 'old-fill'), 'fill');
  assert.equal(scoutRoleForEmoji(snapshot, 'new-mid'), undefined);
  assert.equal(scoutRoleForEmoji(snapshot, null), undefined);
});

test('restart reconciliation preserves existing signup priority before accepting offline additions', () => {
  const observed = [
    { userId: 'player-1', role: 'solo' as const },
    { userId: 'player-1', role: 'jungle' as const },
    { userId: 'player-1', role: 'mid' as const },
  ];
  const prioritized = prioritizeObservedScoutSignups(observed, [
    { userId: 'player-1', role: 'mid' },
    { userId: 'player-1', role: 'solo' },
  ]);

  assert.deepEqual(selectReconciledScoutSignups(prioritized, 2), {
    accepted: [observed[2], observed[0]],
    rejected: [observed[1]],
  });
});

test('restart reconciliation keeps deterministic role-limit signups and identifies excess reactions', () => {
  const observed = [
    { userId: 'player-1', role: 'solo' as const },
    { userId: 'player-1', role: 'jungle' as const },
    { userId: 'player-1', role: 'mid' as const },
    { userId: 'player-2', role: 'fill' as const },
    { userId: 'player-1', role: 'solo' as const },
  ];

  assert.deepEqual(selectReconciledScoutSignups(observed, 2), {
    accepted: observed.slice(0, 2).concat(observed.slice(3, 4)),
    rejected: [observed[2]],
  });
});
