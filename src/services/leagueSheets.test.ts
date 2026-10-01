import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRenamePlan, buildTradePlan } from '../domain/leagueOperations.js';
import { LeagueSheetsService, type LeagueSheetsGateway, type SheetValueUpdate } from './leagueSheets.js';

type Rows = (string | number | boolean | null)[][];

function emptyPublic(): Rows { return Array.from({ length: 99 }, () => Array(15).fill('')); }

class FakeGateway implements LeagueSheetsGateway {
  readonly data = new Map<string, Rows>();
  readonly writes: { spreadsheetId: string; updates: SheetValueUpdate[]; option: 'RAW' | 'USER_ENTERED' }[] = [];
  readonly appends: { spreadsheetId: string; range: string; values: Rows; option: 'RAW' | 'USER_ENTERED' }[] = [];
  readonly reads: { spreadsheetId: string; range: string }[] = [];
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
      if (update.range.startsWith("'Current Rosters'!A6:")) {
        const key = this.key(spreadsheetId, "'Current Rosters'!A5:J1000");
        const header = this.data.get(key)![0]!;
        this.data.set(key, [header, ...update.values.map((row) => row.map(evaluate))]);
      } else {
        const publicMatch = /^'([^']+) Roster'!([A-O])(\d+)$/.exec(update.range);
        if (publicMatch) {
          const key = this.key(spreadsheetId, `'${publicMatch[1]} Roster'!A1:O99`);
          const rows = this.data.get(key)!;
          rows[Number(publicMatch[3]) - 1]![publicMatch[2]!.charCodeAt(0) - 65] = update.values[0]![0]!;
        }
        const nameMatch = /^'Player Name History'!([BE])(\d+)(?::G\d+)?$/.exec(update.range);
        if (nameMatch) {
          const key = this.key(spreadsheetId, "'Player Name History'!A5:K1000");
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
    ['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', 'one', 'OneLive', 'Captain', 'OK', 'audit', 'now'],
    ['Vanaheim', 'The Sewer', 'team-b', 'The Sewer VD', 'two', 'TwoLive', 'Player', 'OK', 'audit', 'now'],
  ];
  const names: Rows = [
    ['Discord ID', 'Current League Name', 'Known Name', 'Name Status', 'Division', 'Franchise', 'League Status', 'Recorded On', 'Last Confirmed', 'Found In', 'Notes'],
    ['one', 'One', 'OneLive', 'Current Discord Name', 'Vanaheim', 'Dream Walkers', 'Captain', '', '', '', ''],
    ['two', 'Two', 'TwoLive', 'Current Discord Name', 'Vanaheim', 'The Sewer', 'Player', '', '', '', ''],
  ];
  gateway.data.set(gateway.key('admin', "'League Teams'!A5:L100"), teams);
  gateway.data.set(gateway.key('admin', "'Current Rosters'!A5:J1000"), rosters);
  gateway.data.set(gateway.key('admin', "'Player Name History'!A5:K1000"), names);
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim']) {
    const rows = emptyPublic();
    if (division === 'Vanaheim') { rows[4]![2] = 'One'; rows[15]![6] = 'Two'; }
    gateway.data.set(gateway.key('public', `'${division} Roster'!A1:O99`), rows);
  }
  return { gateway, service: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }) };
}

const members = [
  { discordId: 'one', displayName: 'OneLive', roleIds: ['team-a', 'division-v'] },
  { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-b', 'division-v'] },
];

test('league sheet reader maps only the configured managed tabs and cells', async () => {
  const { service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.teams.length, 2);
  assert.equal(loaded.snapshot.rosters[0]?.discordId, 'one');
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.teams['Dream Walkers'], ['One']);
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.freeAgents, []);
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

test('trade writes the sorted admin roster and only the two exact public player cells', async () => {
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
  const reloaded = await service.load([
    { discordId: 'one', displayName: 'OneLive', roleIds: ['team-b', 'division-v'] },
    { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-a', 'division-v'] },
  ], 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'one')?.teamRoleId, 'team-b');
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
  const loaded = await service.load(members, 'free-agent');
  const plan = buildRenamePlan(loaded.snapshot, 'one', '007');
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-TEXT', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));
  assert.equal(gateway.writes.filter((write) => write.spreadsheetId === 'admin').every((write) => write.option === 'RAW'), true);
  const reloaded = await service.load(members, 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'one')?.player, '007');
  assert.equal(reloaded.snapshot.names.find((row) => row.discordId === 'one')?.currentLeagueName, '007');
});

test('free-agent rename history records the affected division', async () => {
  const { gateway, service } = serviceFixture();
  gateway.data.get(gateway.key('admin', "'Player Name History'!A5:K1000"))!.push(
    ['free', 'Free', 'FreeLive', 'Current Discord Name', 'Vanaheim', '', 'Free Agent', '', '', '', ''],
  );
  const loaded = await service.load([
    ...members,
    { discordId: 'free', displayName: 'FreeLive', roleIds: ['free-agent', 'division-v'] },
  ], 'free-agent');
  const plan = buildRenamePlan(loaded.snapshot, 'free', 'Free Prime');
  await service.appendTransactionHistory(plan, {
    reference: 'YSL-TRX-FREE-RENAME', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  });
  assert.equal(gateway.appends[0]?.values[0]?.[3], 'Vanaheim');
  assert.ok(gateway.reads.some((read) => read.range === "'Transaction History'!A6:A"));
});

test('roster rewrites clear through the last occupied physical row after an internal blank', async () => {
  const { gateway, service } = serviceFixture();
  const source = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J1000"))!;
  source.splice(2, 0, Array(10).fill(''));
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.rosters.find((row) => row.discordId === 'two')?.sheetRow, 8);
  const plan = buildTradePlan(loaded.snapshot, 'one', 'two');
  await service.apply(loaded, plan, {
    reference: 'YSL-TRX-SPARSE', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }, service.prepare(loaded, plan));
  const rosterWrite = gateway.writes.flatMap((write) => write.updates)
    .find((update) => update.range.startsWith("'Current Rosters'!A6:"));
  assert.equal(rosterWrite?.range, "'Current Rosters'!A6:J8");
  const reloaded = await service.load(members, 'free-agent');
  assert.deepEqual(reloaded.snapshot.rosters.map((row) => row.discordId), ['two', 'one']);
});

test('partially populated roster rows fail closed before any rewrite', async () => {
  const { gateway, service } = serviceFixture();
  const source = gateway.data.get(gateway.key('admin', "'Current Rosters'!A5:J1000"))!;
  source.splice(2, 0, ['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', '', 'Unlinked Player', 'Player']);
  await assert.rejects(() => service.load(members, 'free-agent'), /row 7 is partially populated/i);
  assert.equal(gateway.writes.length, 0);
});
