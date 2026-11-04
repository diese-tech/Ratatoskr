import { Collection } from 'discord.js';
import { executeLeagueTransaction, LeagueTransactionPreviewChangedError } from '../services/leagueTransactions.js';
import { buildLeagueIntentPlan, type LeagueTransactionIntent } from '../services/leagueTransactionIntent.js';
import { LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { DiscordLeagueGateway } from '../services/leagueDiscord.js';
import { LeagueSheetsService } from '../services/leagueSheets.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';
import { buildTradePlan, type LeagueRosterRow, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { openDatabase } from '../db/client.js';
import { saveLeagueTransactionPreview } from '../db/repositories/leagueOperations.js';
import { getLeagueJob, leagueJobPriority, listActionableLeagueJobs, type LeagueJobType } from '../db/repositories/leagueJobs.js';
import { LeagueJobBlockedError, LeagueJobWorker, registerLeagueJobWorker, type LeagueJobHandler } from '../services/leagueJobWorker.js';
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
      options: { getSubcommand: () => 'trade', getBoolean: () => true, getRole: () => null,
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
    'Rat cannot show this player change yet: <@first-admin> is not rostered on an active YSL team.\n\nNo changes were made.',
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

test('a Discord cooldown while building a /transaction preview is a private no-change reply, not a staff incident', async (t) => {
  const db = openDatabase(':memory:');
  const warn = t.mock.method(console, 'warn', () => {});
  const configured = { ROLE_FREE_AGENT_ID: 'fa', YSL_TRANSACTIONS_CHANNEL_ID: 'notices',
    YSL_ADMIN_SPREADSHEET_ID: 'test-admin', YSL_PUBLIC_SPREADSHEET_ID: 'test-public',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@example.com', private_key: 'synthetic-test-key' }) };
  const previous = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  try {
    // An earlier reviewed preview for a different intent must survive a read-only deferral.
    saveLeagueTransactionPreview(db, { guildId: 'g', actorUserId: 'valk-admin', intentKey: 'other', planFingerprint: 'kept' });
    let wholeGuildFetches = 0;
    const staff = { displayName: 'Staff', roles: { cache: new Map([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) } };
    const guild = { id: 'g', members: { fetch: async (options?: unknown) => {
      if (options) return staff;
      wholeGuildFetches += 1;
      throw Object.assign(new Error('Request with opcode 8 was rate limited.'), { data: { opcode: 8, retry_after: 30 } });
    } } };
    for (const confirm of [false, true]) {
      const replies: string[] = [];
      await handleTransactionCommand({ guild, user: { id: 'valk-admin' },
        options: { getSubcommand: () => 'trade', getBoolean: () => confirm, getRole: () => null,
          getUser: (name: string) => ({ id: name === 'player_one' ? 'one' : 'two' }) },
        deferReply: async () => {}, editReply: async (reply: string) => { replies.push(reply); } } as never, db, db);
      assert.equal(replies.length, 1);
      assert.match(replies[0]!, /^Discord asked Rat to wait before checking the member list again\. No changes were made\. Run the same \/transaction command again in 3\d seconds\.$/);
    }
    assert.equal(wholeGuildFetches, 1, 'the shared cooldown defers the second attempt without another request');
    assert.equal(warn.mock.callCount(), 2);
    assert.equal((db.prepare('SELECT count(*) n FROM league_jobs').get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM league_transaction_previews WHERE plan_fingerprint='kept'").get() as { n: number }).n, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    db.close();
  }
});

test('trade offers an optional counterpart and a receiving team role, and rejects both or neither privately', async () => {
  const command = transactionCommand.toJSON().options?.find(option => option.name === 'trade');
  const options = command && 'options' in command ? command.options : [];
  assert.equal(options?.find(option => option.name === 'player_two')?.required ?? false, false);
  assert.equal(options?.find(option => option.name === 'receiving_team')?.type, 8);
  const db = openDatabase(':memory:');
  try {
    for (const supplied of [true, false]) {
      const replies: string[] = [];
      await handleTransactionCommand({
        guild: { id: 'g', members: { fetch: async () => ({ roles: { cache: new Map([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) } }) } },
        user: { id: 'staff' },
        options: { getSubcommand: () => 'trade', getBoolean: () => true,
          getUser: (name: string) => name === 'player_one' ? { id: 'one' } : supplied ? { id: 'two' } : null,
          getRole: () => supplied ? { id: 'team-b' } : null },
        deferReply: async (reply: { flags: number }) => assert.equal(reply.flags, 64),
        editReply: async (reply: string) => { replies.push(reply); },
      } as never, db, db);
      assert.equal(replies.length, 1);
      assert.match(replies[0]!, /player_two.*receiving_team.*Choose exactly one.*No changes were made/);
    }
    assert.deepEqual(db.prepare('SELECT count(*) n FROM league_jobs').get(), { n: 0 });
    assert.deepEqual(db.prepare('SELECT count(*) n FROM league_transaction_previews').get(), { n: 0 });
  } finally { db.close(); }
});

for (const scenario of ['stale', 'cooldown', 'role error'] as const) {
test(`one-way trade uses the shared member reader through preview and rapid confirmation: ${scenario}`, async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  for (const [key, value] of Object.entries({ ROLE_FREE_AGENT_ID: 'fa', YSL_TRANSACTIONS_CHANNEL_ID: 'notices',
    YSL_ADMIN_SPREADSHEET_ID: 'test-admin', YSL_PUBLIC_SPREADSHEET_ID: 'test-public',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@example.com', private_key: 'synthetic-test-key' }) })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const snapshot: LeagueSnapshot = {
    teams: ['A', 'B'].map(franchise => ({
      teamKey: 'Vanaheim|' + franchise, franchise, division: 'Vanaheim', teamRoleId: franchise,
      teamRole: franchise + ' VD', divisionRoleId: 'division', active: true,
    })),
    rosters: [{ sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId: 'A', team: 'A VD',
      discordId: 'one', player: 'One', rosterStatus: 'Player' }],
    names: [{ sheetRow: 6, discordId: 'one', currentLeagueName: 'One', knownName: 'One',
      nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Player' }],
    discordMembers: [{ discordId: 'one', displayName: 'One', roleIds: ['A', 'division'] }],
    publicRosters: { Vanaheim: { teams: { A: ['One'], B: [] }, freeAgents: [] } },
    freeAgentRoleId: 'fa',
  };
  const staff = { displayName: 'Staff', roles: { cache: new Map([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) } };
  const member = { id: 'one', displayName: 'One', user: { bot: false }, roles: { cache: new Map([['A', {}], ['division', {}]]) } };
  let fullReads = 0;
  let actorReads = 0;
  const guild = { id: 'g', memberCount: 1, members: { fetch: async (options?: { force: boolean; user: string }) => {
    if (options) {
      assert.deepEqual(options, { user: 'staff', force: true });
      actorReads++;
      return staff;
    }
    fullReads++;
    if (scenario === 'cooldown' && fullReads > 1)
      throw Object.assign(new Error('Request with opcode 8 was rate limited.'), { data: { opcode: 8, retry_after: 30 } });
    return new Collection([['one', member]]);
  } } };
  const discord = new DiscordLeagueGateway(guild as never, 'notices');
  const sheets = new LeagueSheetsService({} as never, { adminSpreadsheetId: 'test-admin', publicSpreadsheetId: 'test-public' });
  const handler: LeagueJobHandler = async (job, phase) => {
    const intent = job.payload as LeagueTransactionIntent;
    try {
      return await executeLeagueTransaction({
        db, operationScope: db, guildId: 'g', actorUserId: intent.actorUserId, actorName: 'Staff',
        now: new Date(), freeAgentRoleId: 'fa', sheets, discord, onPhase: phase,
        expectedPlanFingerprint: intent.expectedPlanFingerprint, jobReference: job.reference,
        buildPlan: current => buildLeagueIntentPlan(intent.selections, current),
      });
    } catch (error) {
      if (error instanceof LeagueTransactionPreviewChangedError) throw new LeagueJobBlockedError('BLOCKED_REVIEW', error.message);
      throw error;
    }
  };
  const worker = new LeagueJobWorker(db, 'g', { transaction: handler } as Record<LeagueJobType, LeagueJobHandler>, async () => {});
  worker.stop();
  registerLeagueJobWorker(db, worker);
  t.after(() => worker.stop());
  t.mock.method(console, 'error', () => {});
  t.mock.method(DiscordLeagueGateway.prototype, 'validateOneWayTradeRoles', async () => {
    if (scenario === 'role error')
      throw new LeagueMutationValidationError('A configured league role is missing, privileged, integration-owned or not editable by Ratatoskr.');
  });
  t.mock.method(DiscordLeagueGateway.prototype, 'validateDisplayName', async () => {});
  t.mock.method(LeagueSheetsService.prototype, 'load', async (discordMembers: LeagueSnapshot['discordMembers']) => ({
    snapshot: { ...snapshot, discordMembers }, sources: {} as never,
  }));
  t.mock.method(LeagueSheetsService.prototype, 'prepare', () => ({ publicUpdates: [] }));
  t.mock.method(LeagueSheetsService.prototype, 'assertOneWayTradeDestination', async () => {});
  t.mock.method(LeagueSheetsService.prototype, 'apply', async () => assert.fail('Preview or confirm wrote Sheets'));
  t.mock.method(DiscordLeagueGateway.prototype, 'applyRoleChange', async () => assert.fail('Preview or confirm wrote roles'));
  const invoke = async (confirm: boolean) => {
    const replies: string[] = [];
    await handleTransactionCommand({
      guild,
      user: { id: 'staff' },
      options: { getSubcommand: () => 'trade', getBoolean: () => confirm,
        getUser: (name: string) => name === 'player_one' ? { id: 'one' } : null, getRole: () => ({ id: 'B' }) },
      deferReply: async (reply: { flags: number }) => assert.equal(reply.flags, 64),
      editReply: async (reply: string) => { replies.push(reply); },
    } as never, db, db);
    return replies.join('\n');
  };
  const preview = await invoke(false);
  assert.equal(fullReads, 1);
  if (scenario === 'role error') {
    assert.match(preview, /check permissions.*\n\nNo changes were made\./);
    assert.doesNotMatch(preview, /privileged|integration-owned/);
    assert.deepEqual(db.prepare('SELECT count(*) n FROM league_jobs').get(), { n: 0 });
    return;
  }
  assert.match(preview, /1-for-0.*\nOne.*A → B\nA roster: 1 → 0\nB roster: 0 → 1/);
  if (scenario === 'stale') snapshot.teams[1]!.teamRole = 'Renamed B VD';
  const queued = await invoke(true);
  assert.match(queued, /YSL-JOB-/);
  assert.equal(await invoke(true), queued);
  assert.equal(fullReads, 1, 'confirmation and duplicate confirmation do not request opcode 8');
  assert.equal(actorReads, 3, 'every interaction refreshes the staff member');
  const row = db.prepare("SELECT reference, json_extract(payload_json, '$.selections') AS selections FROM league_jobs").get() as { reference: string; selections: string };
  assert.equal(row.selections, '["trade-one-way","one","B"]');
  const status = scenario === 'stale' ? 'BLOCKED_REVIEW' : 'RETRYING';
  const began = Date.now();
  worker.start();
  for (let i = 0; i < 100 && getLeagueJob(db, row.reference)?.status !== status; i++)
    await new Promise(resolve => setImmediate(resolve));
  worker.stop();
  assert.equal(getLeagueJob(db, row.reference)?.status, status);
  assert.equal(fullReads, 2, 'worker performs one fresh complete read');
  assert.deepEqual(db.prepare('SELECT count(*) n FROM league_transactions').get(), { n: 0 });
  if (scenario === 'cooldown') {
    assert.ok(Date.parse(getLeagueJob(db, row.reference)!.availableAt) >= began + 30_000);
    assert.match(await invoke(false), /Discord asked Rat to wait.*No changes were made/);
    assert.equal(fullReads, 2, 'a preview during the shared cooldown sends no request');
  } else {
    assert.match(await invoke(true), /stopped this trade before making any changes/);
    assert.equal(fullReads, 2, 'blocked confirmation does not automatically redraw');
  }
});
}

test('roster autocomplete orders Niflheim rows after Svartalfheim (#197)', () => {
  const row = (division: 'Svartalfheim' | 'Niflheim', discordId: string) => ({
    sheetRow: 6, division, franchise: 'The Rat Pack', teamRoleId: discordId, team: 'The Rat Pack', discordId, player: 'Same', rosterStatus: 'Player' as const,
  });
  assert.deepEqual(buildRosterPlayerAutocompleteChoices([row('Niflheim', 'n'), row('Svartalfheim', 's')], '')
    .map((choice) => choice.name), ['Same — The Rat Pack (Svartalfheim)', 'Same — The Rat Pack (Niflheim)']);
});
