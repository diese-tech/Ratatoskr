import assert from 'node:assert/strict';
import test from 'node:test';
import { rankScoutReplacementCandidates } from './scoutReplacementCandidates.js';

test('replacement candidates are unique, exact-role first, then visibly off-role', () => {
  const candidates = rankScoutReplacementCandidates([
    { id: 1, setupId: 1, userId: 'off', role: 'mid', createdAt: '1' },
    { id: 2, setupId: 1, userId: 'exact', role: 'solo', createdAt: '2' },
    { id: 3, setupId: 1, userId: 'fill', role: 'fill', createdAt: '3' },
    { id: 4, setupId: 1, userId: 'off', role: 'support', createdAt: '4' },
    { id: 5, setupId: 1, userId: 'seated', role: 'solo', createdAt: '5' },
  ], new Set(['seated']), 'solo');

  assert.deepEqual(candidates.map((candidate) => ({ userId: candidate.userId, offRole: candidate.offRole })), [
    { userId: 'exact', offRole: false },
    { userId: 'fill', offRole: false },
    { userId: 'off', offRole: true },
  ]);
  assert.deepEqual(candidates[2]?.roles, ['mid', 'support']);
});
