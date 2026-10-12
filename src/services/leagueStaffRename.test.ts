import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLeagueSnapshot } from './leagueOpsFixtures.test-support.js';
import { buildLeagueIntentPlan } from './leagueTransactionIntent.js';

test('staff rename plans the requested nickname without requiring players to rename themselves first', () => {
  const snapshot = cleanLeagueSnapshot();
  Object.assign(snapshot.discordMembers[0]!, { nickname: null });
  const plan = buildLeagueIntentPlan('["rename","one","One Prime"]', snapshot);
  assert.equal(plan.rosters[0]?.player, 'One Prime');
  assert.equal(plan.nameUpdates[0]?.knownName, 'One');
  assert.deepEqual(plan.discordNicknameChange, { discordId: 'one', before: null, beforeDisplayName: 'One', after: 'One Prime' });
});

test('nickname previews reject missing before-state, blank/oversized names and absent players', () => {
  const snapshot = cleanLeagueSnapshot();
  assert.throws(() => buildLeagueIntentPlan('["rename","one","One Prime"]', snapshot), /nickname could not be verified/);
  snapshot.discordMembers[0]!.nickname = null;
  for (const name of ['', ' ', 'x'.repeat(33), 'unsafe\nname'])
    assert.throws(() => buildLeagueIntentPlan(JSON.stringify(['rename', 'one', name]), snapshot), /1–32/);
  assert.throws(() => buildLeagueIntentPlan('["rename","absent","Other"]', snapshot), /not currently/);
});

test('staff can restore the existing official name as a nickname without duplicating history or public cells', () => {
  const snapshot = cleanLeagueSnapshot();
  Object.assign(snapshot.discordMembers[0]!, { nickname: 'Wrong Name', displayName: 'Wrong Name' });
  const plan = buildLeagueIntentPlan('["rename","one","One"]', snapshot);
  assert.equal(plan.discordNicknameChange?.after, 'One');
  assert.deepEqual(plan.publicChanges, []);
  assert.equal(plan.nameHistoryAppend, undefined);
});
