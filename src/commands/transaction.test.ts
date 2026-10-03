import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';
import { buildTradePlan, type LeagueRosterRow, type LeagueSnapshot } from '../domain/leagueOperations.js';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';

const { buildDepartureAutocompleteChoices, replyToTransactionValidation, transactionCommand } = await import('./transaction.js');

test('departure uses roster-backed autocomplete instead of Discord user selection', () => {
  const departure = transactionCommand.toJSON().options?.find((option) => option.name === 'departure');
  const player = 'options' in departure! ? departure.options?.find((option) => option.name === 'player') : undefined;
  assert.equal(player?.type, 3);
  assert.equal('autocomplete' in player! ? player.autocomplete : false, true);
});

test('departure autocomplete is human-readable, division-ordered, and stores stable Discord IDs', () => {
  const row = (overrides: Partial<LeagueRosterRow>): LeagueRosterRow => ({
    sheetRow: 6,
    division: 'Vanaheim',
    franchise: 'Dream Walkers',
    teamRoleId: 'team-a',
    team: 'Dream Walkers VD',
    discordId: 'one',
    player: 'One',
    rosterStatus: 'Player',
    ...overrides,
  });
  const choices = buildDepartureAutocompleteChoices([
    row({ division: 'Svartalfheim', franchise: 'The Sewer', discordId: 'three', player: 'Three' }),
    row({ division: 'Alfheim', franchise: 'Wailing Banshees', discordId: 'two', player: 'Two' }),
    row({}),
  ], 'wailing');
  assert.deepEqual(choices, [{ name: 'Two — Wailing Banshees (Alfheim)', value: 'two' }]);
  assert.deepEqual(buildDepartureAutocompleteChoices([
    row({ division: 'Svartalfheim', discordId: 'three', player: 'Three' }),
    row({ division: 'Alfheim', discordId: 'two', player: 'Two' }),
    row({}),
  ], '').map((choice) => choice.value), ['one', 'two', 'three']);
});

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
