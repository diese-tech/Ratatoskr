import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';
import { buildTradePlan, type LeagueRosterRow, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { openDatabase } from '../db/client.js';
import { saveLeagueTransactionPreview } from '../db/repositories/leagueOperations.js';
import { leagueJobPriority, listActionableLeagueJobs, type LeagueJobType } from '../db/repositories/leagueJobs.js';
import { LeagueJobWorker, registerLeagueJobWorker, type LeagueJobHandler } from '../services/leagueJobWorker.js';
import { LEGACY_YSL_VALKYRIE_ROLE_ID } from '../config/staff-role-ids.js';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';
delete process.env.ROLE_VALKYRIE_ID;

const { buildRosterPlayerAutocompleteChoices, handleTransactionCommand, replyToTransactionValidation, transactionCommand } = await import('./transaction.js');

test('Valkyrie-only staff can confirm a saved transaction preview into the canonical queue', async () => {
  const db = openDatabase(':memory:');
  const handler: LeagueJobHandler = async () => assert.fail('Confirmation must queue, not execute during the command');
  const handlers = Object.fromEntries(Object.keys(leagueJobPriority).map((type) => [type, handler])) as Record<LeagueJobType, LeagueJobHandler>;
  const worker = new LeagueJobWorker(db, 'g', handlers, async () => {});
  worker.stop();
  registerLeagueJobWorker(db, worker);
  const replies: string[] = [];
  const configured = { ROLE_FREE_AGENT_ID: 'fa', YSL_TRANSACTIONS_CHANNEL_ID: 'notices',
    YSL_ADMIN_SPREADSHEET_ID: 'test-admin', YSL_PUBLIC_SPREADSHEET_ID: 'test-public',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@example.com', private_key: 'synthetic-test-key' }) };
  const previous = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  try {
    saveLeagueTransactionPreview(db, { guildId: 'g', actorUserId: 'valk-admin', intentKey: '["trade","one","two"]', planFingerprint: 'reviewed' });
    await handleTransactionCommand({ guild: { id: 'g', members: { fetch: async () => ({ displayName: 'Staff',
      roles: { cache: new Map([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) } }) } }, user: { id: 'valk-admin' },
      options: { getSubcommand: () => 'trade', getBoolean: () => true,
        getUser: (name: string) => ({ id: name === 'player_one' ? 'one' : 'two' }) },
      deferReply: async () => {}, editReply: async (reply: string) => { replies.push(reply); } } as never, db, db);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /YSL-JOB-/);
    assert.doesNotMatch(replies[0]!, /permission/i);
    assert.equal(listActionableLeagueJobs(db, 'g').length, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM league_jobs WHERE type='transaction' AND status='QUEUED'").get() as { n: number }).n, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    worker.stop(); db.close();
  }
});

test('departure and self-drop use roster-backed autocomplete instead of Discord user selection', () => {
  const options = transactionCommand.toJSON().options ?? [];
  for (const name of ['departure', 'self-drop']) {
    const command = options.find((option) => option.name === name);
    const player = command && 'options' in command
      ? command.options?.find((option) => option.name === 'player')
      : undefined;
    assert.equal(player?.type, 3, `${name} player must use managed-roster text selection`);
    assert.equal('autocomplete' in player! ? player.autocomplete : false, true, `${name} player must autocomplete`);
  }
});

test('exit commands expose an optional Discord replacement and self-drop is a distinct transaction', () => {
  const options = transactionCommand.toJSON().options ?? [];
  for (const name of ['drop', 'departure', 'self-drop']) {
    const command = options.find((option) => option.name === name);
    const replacement = command && 'options' in command
      ? command.options?.find((option) => option.name === 'replacement')
      : undefined;
    assert.equal(replacement?.type, 6, `${name} replacement must use Discord's user picker`);
    assert.equal(replacement?.required ?? false, false);
  }
});

test('rename command accepts a requested server nickname and limits it to Discord nickname length', () => {
  const rename = transactionCommand.toJSON().options?.find((option) => option.name === 'rename');
  const leagueName = rename && 'options' in rename
    ? rename.options?.find((option) => option.name === 'league_name')
    : undefined;
  assert.match(rename?.description ?? '', /Discord nickname/i);
  assert.match(leagueName?.description ?? '', /New server nickname/i);
  assert.equal(leagueName && 'max_length' in leagueName ? leagueName.max_length : undefined, 32);
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
  const choices = buildRosterPlayerAutocompleteChoices([
    row({ division: 'Svartalfheim', franchise: 'The Sewer', discordId: 'three', player: 'Three' }),
    row({ division: 'Alfheim', franchise: 'Wailing Banshees', discordId: 'two', player: 'Two' }),
    row({}),
  ], 'wailing');
  assert.deepEqual(choices, [{ name: 'Two — Wailing Banshees (Alfheim)', value: 'two' }]);
  assert.deepEqual(buildRosterPlayerAutocompleteChoices([
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
