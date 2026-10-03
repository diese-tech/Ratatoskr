import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';
import { buildTradePlan, type LeagueSnapshot } from '../domain/leagueOperations.js';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';

const { replyToTransactionValidation } = await import('./transaction.js');

test('a transaction preview becomes confirmable only after Discord confirms delivery', async () => {
  const events: string[] = [];
  await persistPreviewAfterDelivery(
    async () => { events.push('delivered'); },
    () => { events.push('persisted'); },
  );
  assert.deepEqual(events, ['delivered', 'persisted']);

  let persisted = false;
  await assert.rejects(() => persistPreviewAfterDelivery(
    async () => { throw new Error('Discord delivery failed'); },
    () => { persisted = true; },
  ), /Discord delivery failed/);
  assert.equal(persisted, false);
});

test('a trade preview rejects non-rostered Discord members without escalating an operational failure', async () => {
  const snapshot: LeagueSnapshot = {
    teams: [],
    rosters: [],
    names: [],
    discordMembers: [],
    publicRosters: {},
    freeAgentRoleId: 'free-agent',
  };
  let thrown: unknown;
  try {
    buildTradePlan(snapshot, 'first-admin', 'second-admin');
  } catch (error) {
    thrown = error;
  }

  const replies: string[] = [];
  const handled = await replyToTransactionValidation(
    { editReply: async (content: string) => { replies.push(content); } },
    thrown,
  );

  assert.equal(handled, true);
  assert.deepEqual(replies, [
    'Transaction cannot be previewed: <@first-admin> is not rostered on an active YSL team.\n\nNo changes were made.',
  ]);
});

test('a trade preview still escalates inconsistent roster data as an operational failure', async () => {
  const duplicate = {
    sheetRow: 5,
    division: 'Vanaheim' as const,
    franchise: 'Dream Walkers',
    teamRoleId: 'team-a',
    team: 'Dream Walkers VD',
    discordId: 'duplicated-player',
    player: 'Duplicated',
    rosterStatus: 'Player' as const,
  };
  const snapshot: LeagueSnapshot = {
    teams: [],
    rosters: [duplicate, { ...duplicate, sheetRow: 6 }],
    names: [],
    discordMembers: [],
    publicRosters: {},
    freeAgentRoleId: 'free-agent',
  };
  let thrown: unknown;
  try {
    buildTradePlan(snapshot, 'duplicated-player', 'other-player');
  } catch (error) {
    thrown = error;
  }

  const handled = await replyToTransactionValidation(
    { editReply: async () => { throw new Error('unexpected reply'); } },
    thrown,
  );

  assert.equal(handled, false);
  assert.match((thrown as Error).message, /multiple roster assignments/i);
});
