import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeparturePlan, buildRenamePlan, buildSelfDropPlan, buildTradePlan } from '../domain/leagueOperations.js';
import {
  createLeagueSheetsReadSchedule,
  createScheduledLeagueSheetsGateway,
  LeagueSheetDriftError,
  LeagueSheetInputError,
  LeagueSheetsService,
  type LeagueSheetsGateway,
  type SheetValueUpdate,
} from './leagueSheets.js';

type Rows = (string | number | boolean | null)[][];

function emptyPublic(): Rows { return Array.from({ length: 99 }, () => Array(15).fill('')); }

class FakeGateway implements LeagueSheetsGateway {
  readonly data = new Map<string, Rows>();
  readonly writes: { spreadsheetId: string; updates: SheetValueUpdate[]; option: 'RAW' | 'USER_ENTERED' }[] = [];
  readonly appends: { spreadsheetId: string; range: string; values: Rows; option: 'RAW' | 'USER_ENTERED' }[] = [];
  readonly reads: { spreadsheetId: string; range: string }[] = [];
  readonly presentationWrites: { sheetId: number; writeLegend: boolean; addRule: boolean }[] = [];
  selfDropRuleExists = false;
  changed = false;

  key(spreadsheetId: string, range: string) { return `${spreadsheetId}:${range}`; }
  async getValues(spreadsheetId: string, range: string): Promise<Rows> {
    this.reads.push({ spreadsheetId, range });
    const rows = structuredClone(this.data.get(this.key(spreadsheetId, range)) ?? []);
    if (this.changed && range.includes('Current Rosters')) rows[1]![5] = 'Manual edit';
    return rows;
  }
  async batchUpdate(spreadsheetId: string, updates: SheetValueUpdate[], option: 'RAW' | 'USER_ENTERED' = 'RAW') {
    this.writes.push({ spreadsheetId, updates, option });
    for (const update of updates) {
      const evaluate = (cell: string | number | boolean | null) => {
        if (option !== 'USER_ENTERED' || typeof cell !== 'string') return cell;
        if (/^=\".*\"$/.test(cell)) return cell.slice(2, -1);
        if (/^\d+$/.test(cell)) return Number(cell);
        return cell;
      };
      const rosterMatch = /^'Current Rosters'!A(\d+):J\1$/.exec(update.range);
      if (rosterMatch) {
        const key = this.key(spreadsheetId, "'Current Rosters'!A5:J");
        const rows = this.data.get(key)!;
        const rowIndex = Number(rosterMatch[1]) - 5;
        while (rows.length <= rowIndex) rows.push(Array(10).fill(''));
        rows[rowIndex] = update.values[0]!.map(evaluate);
      } else {
        const historyMatch = /^'Player Name History'!A(\d+):K\1$/.exec(update.range);
        if (historyMatch) {
          const key = this.key(spreadsheetId, "'Player Name History'!A5:K");
          const rows = this.data.get(key)!;
          const rowIndex = Number(historyMatch[1]) - 5;
          while (rows.length <= rowIndex) rows.push(Array(11).fill(''));
          rows[rowIndex] = update.values[0]!.map(evaluate);
        }
        const publicMatch = /^'([^']+) Roster'!([A-O])(\d+)$/.exec(update.range);
        if (publicMatch) {
          const key = this.key(spreadsheetId, `'${publicMatch[1]} Roster'!A1:O99`);
          const rows = this.data.get(key)!;
          rows[Number(publicMatch[3]) - 1]![publicMatch[2]!.charCodeAt(0) - 65] = update.values[0]![0]!;
        }
        const nameMatch = /^'Player Name History'!([BE])(\d+)(?::G\d+)?$/.exec(update.range);
        if (nameMatch) {
          const key = this.key(spreadsheetId, "'Player Name History'!A5:K");
          const rows = this.data.get(key)!;
          const row = rows[Number(nameMatch[2]) - 5]!;
          const start = nameMatch[1]!.charCodeAt(0) - 65;
          update.values[0]!.forEach((cell, index) => { row[start + index] = evaluate(cell); });
        }
      }
    }
  }
  async append(spreadsheetId: string, range: string, values: Rows, option: 'RAW' | 'USER_ENTERED' = 'RAW') {
    this.appends.push({ spreadsheetId, range, values, option });
  }
  async getSelfDropPresentation(spreadsheetId: string) {
    return {
      sheetId: 137554234,
      legend: structuredClone(this.data.get(this.key(spreadsheetId, "'Player Name History'!J4:K4")) ?? []),
      ruleExists: this.selfDropRuleExists,
    };
  }
  async ensureSelfDropPresentation(spreadsheetId: string, presentation: { sheetId: number; writeLegend: boolean; addRule: boolean }) {
    this.presentationWrites.push(presentation);
    if (presentation.writeLegend) {
      this.data.set(this.key(spreadsheetId, "'Player Name History'!J4:K4"), [[
        'Red row', 'Self-Drop: suspended for the current season and banned for the next YSL season.',
      ]]);
    }
    if (presentation.addRule) this.selfDropRuleExists = true;
  }
}

function serviceFixture() {
  const gateway = new FakeGateway();
  const teams: Rows = [
    ['Team Key', 'Franchise', 'Division', 'Team Role ID', 'Team Role', 'Franchise Role ID', 'Franchise Role', 'Division Role ID', 'Division Role', 'Captain Role ID', 'Captain Role', 'Active Team'],
    ['Vanaheim|Dream Walkers', 'Dream Walkers', 'Vanaheim', 'team-a', 'Dream Walkers VD', '', '', 'division-v', 'Vanaheim', '', '', 'Yes'],
    ['Vanaheim|The Sewer', 'The Sewer', 'Vanaheim', 'team-b', 'The Sewer VD', '', '', 'division-v', 'Vanaheim', '', '', 'Yes'],
  ];
  const rosters: Rows = [
    ['Division', 'Franchise', 'Team Role ID', 'Team', 'Discord ID', 'Player', 'Roster Status', 'Check', 'Source', 'Last Updated'],
    ['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', 'one', 'One', 'Captain', 'OK', 'audit', 'now'],
    ['Vanaheim', 'The Sewer', 'team-b', 'The Sewer VD', 'two', 'Two', 'Player', 'OK', 'audit', 'now'],
  ];
  const names: Rows = [
    ['Discord ID', 'Current League Name', 'Known Name', 'Name Status', 'Division', 'Franchise', 'League Status', 'Recorded On', 'Last Confirmed', 'Found In', 'Notes'],
    ['one', 'One', 'OneLive', 'Current Discord Name', 'Vanaheim', 'Dream Walkers', 'Captain', '', '', '', ''],
    ['two', 'Two', 'TwoLive', 'Current Discord Name', 'Vanaheim', 'The Sewer', 'Player', '', '', '', ''],
    ['free', 'Free', 'FreeLive', 'Current Discord Name', 'Vanaheim', '', 'Free Agent', '', '', '', ''],
  ];
  gateway.data.set(gateway.key('admin', "'League Teams'!A5:L100"), teams);
  gateway.data.set(gateway.key('admin', "'Current Rosters'!A5:J"), rosters);
  gateway.data.set(gateway.key('admin', "'Player Name History'!A5:K"), names);
  gateway.data.set(gateway.key('admin', "'Player Name History'!J4:K4"), []);
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim']) {
    const rows = emptyPublic();
    if (division === 'Vanaheim') { rows[4]![2] = 'One'; rows[15]![6] = 'Two'; rows[24]![6] = 'Free'; }
    gateway.data.set(gateway.key('public', `'${division} Roster'!A1:O99`), rows);
  }
  return { gateway, service: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }) };
}

const members = [
  { discordId: 'one', displayName: 'OneLive', roleIds: ['team-a', 'division-v'] },
  { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-b', 'division-v'] },
  { discordId: 'free', displayName: 'FreeLive', roleIds: ['free-agent', 'division-v'] },
];

test('league sheet reader maps only the configured managed tabs and cells', async () => {
  const { service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.teams.length, 2);
  assert.equal(loaded.snapshot.rosters[0]?.discordId, 'one');
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.teams['Dream Walkers'], ['One']);
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.freeAgents, ['Free']);
});

test('a shifted Player Name History row reports the exact safe repair instead of a generic failure', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.get(gateway.key('admin', "'Player Name History'!A5:K"))!.push([
    '', '396502746364117012', 'oJaeger- (Meisner)', 'oJaeger-', 'Previous / Alternate',
    'Alfheim', 'Little Monsters', 'Player', '2026-10-04', '2026-10-04', 'Ratatoskr approved roster audit repair',
  ]);
  await assert.rejects(
    () => service.load(members, 'free-agent'),
    (error: unknown) => error instanceof LeagueSheetInputError
      && error.operationalCode === 'LEAGUE_SHEET_MISSING_DISCORD_ID'
      && /Player Name History row 9/i.test(error.operationalSummary)
      && /column A/i.test(error.operationalSummary)
      && /move the existing row values one column left/i.test(error.operationalNext)
      && error.operationalNoChanges,
  );
});

test('sheet preflight aborts before all writes when any audited value drifted', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildTradePlan(loaded.snapshot, 'one', 'two');
  const prepared = service.prepare(loaded, plan);
  gateway.changed = true;
  await assert.rejects(() => service.apply(loaded, plan, {
    reference: 'YSL-TRX-1', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, prepared), /changed after the audit/i);
  assert.equal(gateway.writes.length, 0);
});

test('sheet preflight classifies a newly malformed sheet as safe pre-write drift', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildTradePlan(loaded.snapshot, 'one', 'two');
  gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))![1]![6] = 'Starter';
  await assert.rejects(
    () => service.apply(loaded, plan, {
      reference: 'YSL-TRX-MALFORMED', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
    }, service.prepare(loaded, plan)),
    (error: unknown) => error instanceof LeagueSheetDriftError
      && /became unreadable after the audit.*unsupported Roster Status/i.test(error.message),
  );
  assert.equal(gateway.writes.length, 0);
});

test('public roster destinations are resolved before a mutation can begin', async () => {
  const { gateway, service } = serviceFixture();
  const publicRows = gateway.data.get(gateway.key('public', "'Vanaheim Roster'!A1:O99"))!;
  for (let row = 4; row <= 10; row += 1) publicRows[row]![2] = `Player ${row}`;
  const loaded = await service.load(members, 'free-agent');
  const plan = {
    ...buildTradePlan(loaded.snapshot, 'one', 'two'),
    publicChanges: [{ division: 'Vanaheim' as const, area: 'team' as const, group: 'Dream Walkers', from: '', to: 'New Player' }],
  };
  assert.throws(() => service.prepare(loaded, plan), /No empty slot.*Dream Walkers/i);
  assert.equal(gateway.writes.length, 0);
});

test('trade writes only the affected admin rows and the two exact public player cells', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildTradePlan(loaded.snapshot, 'one', 'two');
  const prepared = service.prepare(loaded, plan);
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-1', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, prepared);
  const publicRanges = gateway.writes.filter((write) => write.spreadsheetId === 'public')
    .flatMap((write) => write.updates.map((update) => update.range));
  assert.deepEqual(publicRanges, ["'Vanaheim Roster'!C5", "'Vanaheim Roster'!G16"]);
  const adminRosterRanges = gateway.writes.filter((write) => write.spreadsheetId === 'admin')
    .flatMap((write) => write.updates.map((update) => update.range))
    .filter((range) => range.startsWith("'Current Rosters'!"));
  assert.deepEqual(adminRosterRanges, ["'Current Rosters'!A6:J6", "'Current Rosters'!A7:J7"]);
  const reloaded = await service.load([
    { discordId: 'one', displayName: 'OneLive', roleIds: ['team-b', 'division-v'] },
    { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-a', 'division-v'] },
  ], 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'one')?.teamRoleId, 'team-b');
});

test('self-drop replacement writes one vacated roster row and installs the guarded red-row presentation', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildSelfDropPlan(loaded.snapshot, 'one', 'free');
  const prepared = service.prepare(loaded, plan);
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-SELF-DROP', effectiveDate: '2026-10-03', processedById: 'admin', processedBy: 'Admin',
  }, prepared);

  const rosterRanges = gateway.writes.filter((write) => write.spreadsheetId === 'admin')
    .flatMap((write) => write.updates.map((update) => update.range))
    .filter((range) => range.startsWith("'Current Rosters'!"));
  assert.deepEqual(rosterRanges, ["'Current Rosters'!A6:J6"]);
  assert.deepEqual(gateway.presentationWrites, [{ sheetId: 137554234, writeLegend: true, addRule: true }]);
  const reloaded = await service.load([
    { discordId: 'one', displayName: 'OneLive', roleIds: ['division-v'] },
    { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-b', 'division-v'] },
    { discordId: 'free', displayName: 'FreeLive', roleIds: ['team-a', 'division-v'] },
  ], 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'free')?.sheetRow, 6);
  assert.match(reloaded.snapshot.names.find((row) => row.discordId === 'one')!.leagueStatus, /Self-Drop/);
  assert.equal(reloaded.sources.selfDropPresentation.ruleExists, true);
});

test('self-drop refuses to overwrite an unexpected legend value', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.set(gateway.key('admin', "'Player Name History'!J4:K4"), [['Manual legend', 'Keep me']]);
  const loaded = await service.load(members, 'free-agent');
  assert.throws(() => service.prepare(loaded, buildSelfDropPlan(loaded.snapshot, 'one')), /legend cells J4:K4.*unexpected/i);
  assert.equal(gateway.writes.length, 0);
  assert.equal(gateway.presentationWrites.length, 0);
});

test('public verification accepts a pickup written into an internal managed-block gap', async () => {
  const { gateway, service } = serviceFixture();
  const publicRows = gateway.data.get(gateway.key('public', "'Vanaheim Roster'!A1:O99"))!;
  publicRows[6]![2] = 'Third';
  const loaded = await service.load(members, 'free-agent');
  const plan = {
    kind: 'rename' as const,
    rosters: loaded.snapshot.rosters,
    nameUpdates: loaded.snapshot.names,
    publicChanges: [{ division: 'Vanaheim' as const, area: 'team' as const, group: 'Dream Walkers', from: '', to: 'Inserted' }],
    discordRoleChanges: [],
    teams: [],
    players: ['Inserted'],
    playerIds: ['inserted'],
  };
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-GAP', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));
  assert.equal(publicRows[5]![2], 'Inserted');
});

test('numeric-looking league names remain exact text in every managed admin update', async () => {
  const { gateway, service } = serviceFixture();
  const untouchedRoster = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))![2]!;
  untouchedRoster[7] = 'Manual check';
  untouchedRoster[8] = 'League staff note';
  untouchedRoster[9] = '2026-09-29';
  const loaded = await service.load(members, 'free-agent');
  const plan = buildRenamePlan(loaded.snapshot, 'one', '007');
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-TEXT', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));
  assert.equal(gateway.writes.filter((write) => write.spreadsheetId === 'admin').every((write) => write.option === 'RAW'), true);
  const reloaded = await service.load(members, 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'one')?.player, '007');
  assert.equal(reloaded.snapshot.names.find((row) => row.discordId === 'one')?.currentLeagueName, '007');
  assert.deepEqual(untouchedRoster.slice(7, 10), ['Manual check', 'League staff note', '2026-09-29']);
});

test('rename history targets an explicit A-to-K row so Google cannot shift the Discord ID into column B', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildRenamePlan(loaded.snapshot, 'one', 'One Prime');

  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-RENAME', effectiveDate: '2026-10-04', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));

  const historyWrite = gateway.writes.flatMap((write) => write.updates)
    .find((update) => update.range === "'Player Name History'!A9:K9");
  assert.equal(historyWrite?.values[0]?.[0], 'one');
  assert.equal(historyWrite?.values[0]?.length, 11);
  assert.equal(gateway.appends.some((append) => append.range.includes('Player Name History')), false);
});

test('free-agent rename history records the affected division', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildRenamePlan(loaded.snapshot, 'free', 'Free Prime');
  await service.appendTransactionHistory(plan, {
    reference: 'YSL-TRX-FREE-RENAME', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  });
  assert.equal(gateway.appends[0]?.values[0]?.[3], 'Vanaheim');
  assert.ok(gateway.reads.some((read) => read.range === "'Transaction History'!A6:A"));
});

test('departure history records the former team and inactive destination without role changes', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members.filter((member) => member.discordId !== 'one'), 'free-agent');
  const plan = buildDeparturePlan(loaded.snapshot, 'one');
  await service.appendTransactionHistory(plan, {
    reference: 'YSL-TRX-DEPARTURE', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  });
  assert.deepEqual(gateway.appends[0]?.values[0], [
    'YSL-TRX-DEPARTURE', 'departure', '2026-09-30', 'Vanaheim', 'Dream Walkers', 'Inactive',
    'one', 'One', 'admin', '', 'Completed', 'Admin', '',
  ]);
});

test('history marks top-4 draft picks in column M and records the move on Draft Picks', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.set(gateway.key('admin', "'Draft Picks'!A6:I"), [
    ['Vanaheim', 'Dream Walkers', '1', '3', 'Uno', 'other', 'Other', 'Member Directory', 'On drafted team'],
    ['Vanaheim', 'The Sewer', '2', '16', 'Deux', 'two', 'Two', 'Member Directory', 'On drafted team'],
  ]);
  const loaded = await service.load(members, 'free-agent');
  const moves = await service.appendTransactionHistory(buildTradePlan(loaded.snapshot, 'one', 'two'), {
    reference: 'YSL-TRX-TRADE', effectiveDate: '2026-10-09', processedById: 'admin', processedBy: 'Admin',
  });
  assert.equal(gateway.appends[0]?.range, "'Transaction History'!A:M");
  assert.deepEqual(gateway.appends[0]?.values.map((row) => [row[6], row[12]]), [
    ['one', ''],
    ['two', 'Vanaheim The Sewer R2 (#16)'],
  ]);
  assert.deepEqual(moves.map((move) => move.discordId), ['two']);
  assert.deepEqual(gateway.writes.at(-1)?.updates, [
    { range: "'Draft Picks'!I7", values: [['Moved · trade · YSL-TRX-TRADE']] },
  ]);
});

test('history proceeds unmarked when the Draft Picks tab has not been seeded', async () => {
  const { gateway, service } = serviceFixture();
  const getValues = gateway.getValues.bind(gateway);
  gateway.getValues = async (spreadsheetId, range) => {
    if (range.includes('Draft Picks')) throw Object.assign(new Error('Unable to parse range'), { status: 400 });
    return getValues(spreadsheetId, range);
  };
  const loaded = await service.load(members, 'free-agent');
  const moves = await service.appendTransactionHistory(buildTradePlan(loaded.snapshot, 'one', 'two'), {
    reference: 'YSL-TRX-TRADE', effectiveDate: '2026-10-09', processedById: 'admin', processedBy: 'Admin',
  });
  assert.deepEqual(moves, []);
  assert.deepEqual(gateway.appends[0]?.values.map((row) => row[12]), ['', '']);
});

test('history recovery does not re-mark an already recorded reference', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.set(gateway.key('admin', "'Transaction History'!A6:A"), [['YSL-TRX-TRADE']]);
  gateway.data.set(gateway.key('admin', "'Draft Picks'!A6:I"), [
    ['Vanaheim', 'The Sewer', '2', '16', 'Deux', 'two', 'Two', 'Member Directory', 'On drafted team'],
  ]);
  const loaded = await service.load(members, 'free-agent');
  const moves = await service.appendTransactionHistory(buildTradePlan(loaded.snapshot, 'one', 'two'), {
    reference: 'YSL-TRX-TRADE', effectiveDate: '2026-10-09', processedById: 'admin', processedBy: 'Admin',
  });
  assert.deepEqual(moves, []);
  assert.equal(gateway.appends.length, 0);
});

test('combined self-drop history records outgoing discipline and incoming replacement under one reference', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  const plan = buildSelfDropPlan(loaded.snapshot, 'one', 'free');
  await service.appendTransactionHistory(plan, {
    reference: 'YSL-TRX-SELF-DROP', effectiveDate: '2026-10-03', processedById: 'admin', processedBy: 'Admin',
  });
  assert.equal(gateway.appends[0]?.values.length, 2);
  assert.deepEqual(gateway.appends[0]?.values.map((row) => [row[4], row[5], row[6]]), [
    ['Dream Walkers', 'Suspended - Self-Drop (Current + Next Season)', 'one'],
    ['Free Agents', 'Dream Walkers', 'free'],
  ]);
});

test('roster-player lookup reads only Current Rosters for autocomplete', async () => {
  const { gateway, service } = serviceFixture();
  const players = await service.listRosterPlayers();
  assert.deepEqual(players.map((row) => row.discordId), ['one', 'two']);
  assert.deepEqual(gateway.reads, [{ spreadsheetId: 'admin', range: "'Current Rosters'!A5:J" }]);
});

test('roster mutations preserve unrelated rows and internal blanks', async () => {
  const { gateway, service } = serviceFixture();
  const source = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))!;
  source.splice(2, 0, Array(10).fill(''));
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.rosters.find((row) => row.discordId === 'two')?.sheetRow, 8);
  const plan = buildTradePlan(loaded.snapshot, 'one', 'two');
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-SPARSE', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));
  const rosterRanges = gateway.writes.flatMap((write) => write.updates)
    .filter((update) => update.range.startsWith("'Current Rosters'!"))
    .map((update) => update.range);
  assert.deepEqual(rosterRanges, ["'Current Rosters'!A6:J6", "'Current Rosters'!A8:J8"]);
  const reloaded = await service.load(members, 'free-agent');
  assert.deepEqual(reloaded.snapshot.rosters.map((row) => row.discordId), ['one', 'two']);
  assert.equal(source[2]?.every((cell) => cell === ''), true);
});

test('partially populated roster rows fail closed before any rewrite', async () => {
  const { gateway, service } = serviceFixture();
  const source = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))!;
  source.splice(2, 0, ['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', '', 'Unlinked Player', 'Player']);
  await assert.rejects(() => service.load(members, 'free-agent'), /row 7 is partially populated/i);
  assert.equal(gateway.writes.length, 0);
});

test('unsupported roster status fails closed instead of becoming Player', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))![1]![6] = 'Starter';
  await assert.rejects(() => service.load(members, 'free-agent'), /unsupported Roster Status.*Captain or Player/i);
  assert.equal(gateway.writes.length, 0);
});

test('blank current league name fails closed instead of reaching a public roster write', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.get(gateway.key('admin', "'Player Name History'!A5:K"))![1]![1] = '';
  await assert.rejects(() => service.load(members, 'free-agent'), /no Current League Name/i);
  assert.equal(gateway.writes.length, 0);
});

test('player name history reads remain open-ended beyond row 1000', async () => {
  const { gateway, service } = serviceFixture();
  const names = gateway.data.get(gateway.key('admin', "'Player Name History'!A5:K"))!;
  while (names.length < 1001) names.push(Array(11).fill(''));
  names.push(['late', 'Late Player', 'LateLive', 'Former Discord Name', 'Vanaheim', '', 'Free Agent', '', '', '', '']);
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.names.find((row) => row.discordId === 'late')?.sheetRow, 1006);
  assert.ok(gateway.reads.some((read) => read.range === "'Player Name History'!A5:K"));
});

test('current roster reads remain open-ended beyond row 1000', async () => {
  const { gateway, service } = serviceFixture();
  const rosters = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))!;
  while (rosters.length < 1001) rosters.push(Array(10).fill(''));
  rosters.push(['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', 'late', 'Late Player', 'Player', '', '', '']);
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.rosters.find((row) => row.discordId === 'late')?.sheetRow, 1006);
  assert.ok(gateway.reads.some((read) => read.range === "'Current Rosters'!A5:J"));
});

test('partial team configuration fails closed instead of being ignored', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.get(gateway.key('admin', "'League Teams'!A5:L100"))!.push(
    ['', 'Manual Franchise', 'Vanaheim', '', 'Manual VD', '', '', 'division-v', 'Vanaheim', '', '', 'Yes'],
  );
  await assert.rejects(() => service.load(members, 'free-agent'), /League Teams row 8 is partially populated/i);
  assert.equal(gateway.writes.length, 0);
});

test('targeted member reads only managed index tables and affected public divisions, without presentation or writes', async () => {
  const f = serviceFixture();
  const loaded = await f.service.load([], 'fa');
  const discordId = loaded.snapshot.rosters[0]!.discordId;
  f.gateway.reads.length = 0;
  const targeted = await f.service.loadMember(discordId, null, 'fa');
  assert.ok(targeted.rosters.some(row => row.discordId === discordId));
  assert.equal(f.gateway.reads.filter(read => read.spreadsheetId === 'public').length, 1);
  assert.ok(f.gateway.reads.every(read => !read.range.includes('Alfheim Roster') && !read.range.includes('Svartalfheim Roster')));
  assert.deepEqual(f.gateway.writes, []);
  assert.deepEqual(f.gateway.appends, []);
  assert.deepEqual(f.gateway.presentationWrites, []);
});

test('league reads are paced and quota exhaustion delays the next read without replaying the failed request', async () => {
  const { createLeagueSheetsReadSchedule } = await import('./leagueSheets.js');
  let time = 0;
  const waits: number[] = [];
  const schedule = createLeagueSheetsReadSchedule({
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  });
  let attempts = 0;
  const failed = schedule(async () => {
    attempts++;
    throw { status: 429 };
  });
  const next = schedule(async () => 'fresh');
  await assert.rejects(failed);
  assert.equal(await next, 'fresh');
  assert.equal(attempts, 1);
  assert.deepEqual(waits, [60_000]);
  await Promise.all([schedule(async () => 'one'), schedule(async () => 'two')]);
  assert.deepEqual(waits, [60_000, 2000, 2000]);
});

test('full and targeted loads batch fresh ranges per workbook and restrict targeted public reads', async () => {
  const { gateway, service } = serviceFixture();
  const batches: Array<{ spreadsheetId: string; ranges: string[] }> = [];
  (gateway as LeagueSheetsGateway).getValuesBatch = async (spreadsheetId, ranges) => {
    batches.push({ spreadsheetId, ranges });
    return Promise.all(ranges.map((range) => gateway.getValues(spreadsheetId, range)));
  };
  const full = await service.load(members, 'free-agent');
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.ranges.length, 3);
  assert.equal(batches[1]!.ranges.length, 3);
  batches.length = 0;
  const targeted = await service.loadMember('one', members[0]!, 'free-agent');
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1]!.ranges, ["'Vanaheim Roster'!A1:O99"]);
  assert.deepEqual(targeted.rosters, full.snapshot.rosters);
  gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J"))![1]![5] = 'Fresh name';
  const fresh = await service.loadMember('one', members[0]!, 'free-agent');
  assert.equal(fresh.rosters[0]!.player, 'Fresh name');
});

test('gateways for the same service account share pacing and quota cooldown', async () => {
  const { getLeagueSheetsReadSchedule } = await import('./leagueSheets.js');
  let time = 0;
  const waits: number[] = [];
  const clock = { now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; } };
  const runtime = getLeagueSheetsReadSchedule('shared-test@example.com', clock);
  const preview = getLeagueSheetsReadSchedule('shared-test@example.com', clock);
  assert.equal(runtime, preview);
  await assert.rejects(runtime(async () => { throw { status: 429 }; }));
  await preview(async () => 'fresh preview');
  await runtime(async () => 'fresh audit');
  assert.deepEqual(waits, [60_000, 2000]);
  assert.notEqual(getLeagueSheetsReadSchedule('other-test@example.com', clock), runtime);
});

function scheduledFixture() {
  let time = 0;
  const waits: number[] = [];
  const data = serviceFixture().gateway;
  const calls: string[] = [];
  let failure: unknown;
  const schedule = createLeagueSheetsReadSchedule({ now: () => time, wait: async (ms) => { waits.push(ms); time += ms; } });
  const gateway = createScheduledLeagueSheetsGateway(schedule, async <T>(options: { url: string; method?: 'GET' | 'POST' }) => {
    calls.push(options.url);
    if (failure) { const error = failure; failure = undefined; throw error; }
    if (options.method === 'POST') return {} as T;
    const url = new URL(options.url);
    const workbook = url.pathname.split('/')[3]!;
    if (url.pathname.endsWith('values:batchGet')) return { valueRanges: await Promise.all(url.searchParams.getAll('ranges').map(async (range) => ({ values: await data.getValues(workbook, range) }))) } as T;
    if (url.pathname.includes('/values/')) return { values: await data.getValues(workbook, decodeURIComponent(url.pathname.split('/values/')[1]!)) } as T;
    return { sheets: [{ properties: { sheetId: 1, title: 'Player Name History' } }] } as T;
  });
  return { gateway, data, calls, waits, schedule, service: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }), advance: (ms: number) => { time += ms; }, fail: (error: unknown) => { failure = error; } };
}

const presentation = { purpose: 'presentation' } as const;

test('shared Sheets scheduler coalesces concurrent GET and batchGet presentation reads and briefly reuses results', async () => {
  const f = scheduledFixture();
  const other = createScheduledLeagueSheetsGateway(f.schedule, async <T>() => { throw Error('identical in-flight reads must share the existing transport'); return {} as T; });
  const range = "'Current Rosters'!A5:J";
  const [first, second] = await Promise.all([f.gateway.getValues('admin', range, presentation), other.getValues('admin', range, presentation)]);
  assert.equal(f.calls.length, 1);
  first[1]![5] = 'caller mutation';
  assert.notEqual(second[1]![5], 'caller mutation');
  assert.notEqual((await other.getValues('admin', range, presentation))[1]![5], 'caller mutation');
  assert.equal(f.calls.length, 1);
  await Promise.all([f.gateway.getValuesBatch!('admin', [range], presentation), other.getValuesBatch!('admin', [range], presentation)]);
  assert.equal(f.calls.length, 2);
  await f.gateway.getValuesBatch!('admin', [range], presentation);
  assert.equal(f.calls.length, 2);
  f.advance(3001);
  await f.gateway.getValuesBatch!('admin', [range], presentation);
  assert.equal(f.calls.length, 3);
});

test('writes invalidate workbook presentation reads, including ambiguous writes and late in-flight results', async () => {
  const f = scheduledFixture();
  await f.gateway.getValues('admin', 'A1', presentation);
  await f.gateway.getValues('public', 'A1', presentation);
  const before = f.calls.length;
  await f.gateway.append('admin', 'A1', [['write']]);
  await f.gateway.getValues('public', 'A1', presentation);
  assert.equal(f.calls.length, before + 1);
  await f.gateway.getValues('admin', 'A1', presentation);
  assert.equal(f.calls.length, before + 2);
  f.fail({ status: 503 });
  await assert.rejects(f.gateway.batchUpdate('admin', [{ range: 'A1', values: [['write']] }]));
  await f.gateway.getValues('admin', 'A1', presentation);
  assert.equal(f.calls.length, before + 4);
  let release!: (value: string) => void;
  const old = f.schedule(() => new Promise<string>((resolve) => { release = resolve; }), { workbook: 'admin', key: 'late', ...presentation });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.schedule.invalidateWorkbook('admin');
  release('old');
  await old;
  assert.equal(await f.schedule(async () => 'new', { workbook: 'admin', key: 'late', ...presentation }), 'new');
});

test('failed presentation reads are not cached and 429 cooldown still paces the next request', async () => {
  for (const status of [429, 503]) {
    const f = scheduledFixture();
    f.fail({ status });
    await assert.rejects(f.gateway.getValues('admin', 'A1', presentation));
    await f.gateway.getValues('admin', 'A1', presentation);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.waits, [status === 429 ? 60_000 : 2000]);
  }
});

test('autocomplete reuses presentation rows while validation and targeted reconciliation always issue fresh reads', async () => {
  const f = scheduledFixture();
  await Promise.all([f.service.listRosterPlayers(), f.service.listRosterPlayers()]);
  await f.service.listRosterPlayers();
  assert.equal(f.calls.length, 1);
  const loaded = await f.service.load(members, 'free-agent');
  const fullReads = f.calls.length - 1;
  await f.service.load(members, 'free-agent');
  assert.equal(f.calls.length, 1 + 2 * fullReads);
  await f.service.loadMember('one', members[0]!, 'free-agent');
  const before = f.calls.length;
  await f.service.loadMember('one', members[0]!, 'free-agent');
  assert.equal(f.calls.length, before + 2);
  f.data.changed = true;
  await assert.rejects(f.service.assertUnchanged(loaded), LeagueSheetDriftError);
  assert.equal(f.calls.length, before + 2 + fullReads);
});

test('fresh proof reads do not join identical in-flight presentation requests', async () => {
  const f = scheduledFixture();
  await Promise.all([f.gateway.getValues('admin', 'A1', presentation), f.gateway.getValues('admin', 'A1'), f.gateway.getValues('admin', 'A1', { purpose: 'fresh' })]);
  assert.equal(f.calls.length, 3);
});

test('repair confirmation and explicit recovery never reuse presentation or previous proof reads', async () => {
  const { openDatabase } = await import('../db/client.js');
  const { createLeagueAuditRepair, markLeagueAuditRepairReconciliationRequired } = await import('../db/repositories/leagueAuditRepairs.js');
  const { previewLeagueRepairRecovery, reconcileLeagueRepairRecord } = await import('./leagueRepairRecovery.js');
  const { executeLeagueAuditRepair, LeagueAuditRepairStaleError } = await import('./leagueAuditResolution.js');
  const f = scheduledFixture();
  const db = openDatabase(':memory:');
  try {
    createLeagueAuditRepair(db, { reference: 'interrupted', guildId: 'g', auditReference: 'old', actorUserId: 'admin', finding: 'old', action: 'use-discord-name' });
    markLeagueAuditRepairReconciliationRequired(db, 'interrupted', 'unknown');
    await f.service.listRosterPlayers();
    const input = { db, operationScope: db, guildId: 'g', freeAgentRoleId: 'free-agent', members: { getMembers: async () => members }, sheets: f.service };
    const before = f.calls.length;
    const preview = await previewLeagueRepairRecovery(input, 'interrupted');
    const reads = f.calls.length - before;
    assert.equal(reads, 4);
    await assert.rejects(reconcileLeagueRepairRecord({ ...input, reference: 'interrupted', expectedFingerprint: preview.fingerprint, actorUserId: 'admin' }));
    assert.equal(f.calls.length, before + 2 * reads);
    await assert.rejects(executeLeagueAuditRepair({ ...input, auditReference: 'stale', expectedFinding: 'no longer present', actorUserId: 'admin', actorName: 'Admin', action: 'use-discord-name', discord: { validateDisplayName: async () => { throw Error('no writes'); }, reconcileManagedRoles: async () => { throw Error('no writes'); } }, now: new Date() }), LeagueAuditRepairStaleError);
    assert.equal(f.calls.length, before + 3 * reads);
  } finally { db.close(); }
});

test('presentation cache is bounded and incomplete batch reads are never retained', async () => {
  let time = 0;
  const schedule = createLeagueSheetsReadSchedule({ now: () => time, wait: async (ms) => { time += ms; } });
  const pending = Array.from({ length: 129 }, (_, i) => schedule(async () => i, { workbook: 'admin', key: String(i), ...presentation }));
  let attempts = 0;
  const evicted = schedule(async () => { attempts++; return 0; }, { workbook: 'admin', key: '0', ...presentation });
  await Promise.all([...pending, evicted]);
  assert.equal(attempts, 1);
  let batches = 0;
  const gateway = createScheduledLeagueSheetsGateway(schedule, async <T>() => { batches++; return { valueRanges: batches === 1 ? [] : [{ values: [['okay']] }] } as T; });
  await assert.rejects(gateway.getValuesBatch!('admin', ['A1'], presentation), /incomplete/);
  assert.deepEqual(await gateway.getValuesBatch!('admin', ['A1'], presentation), [[['okay']]]);
  assert.equal(batches, 2);
});

test('a workbook write prevents an already-running GET from repopulating presentation reuse', async () => {
  let time = 0;
  const schedule = createLeagueSheetsReadSchedule({ now: () => time, wait: async (ms) => { time += ms; } });
  let release!: (value: unknown) => void;
  let reads = 0;
  const gateway = createScheduledLeagueSheetsGateway(schedule, async <T>(options: { method?: 'GET' | 'POST' }) => {
    if (options.method === 'POST') return {} as T;
    reads++;
    if (reads === 1) return await new Promise<T>((resolve) => { release = (value) => resolve(value as T); });
    return { values: [['after write']] } as T;
  });
  const old = gateway.getValues('admin', 'A1', presentation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await gateway.batchUpdate('admin', [{ range: 'A1', values: [['after write']] }]);
  release({ values: [['before write']] });
  assert.deepEqual(await old, [['before write']]);
  assert.deepEqual(await gateway.getValues('admin', 'A1', presentation), [['after write']]);
  assert.equal(reads, 2);
});
